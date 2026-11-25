/**
 * Analytics routes (Lifecycle Overview and Analytics screens).
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope in
 * app.ts, which enforces request.tenant !== null before any route handler runs.
 *
 * Endpoints:
 *   GET /v1/analytics/lifecycle       state distribution (with depth matrix) + movement
 *   GET /v1/analytics/sending         sending performance over time and per flow
 *   GET /v1/analytics/retention-grid  tenure x recency cell counts (retention grid)
 *   GET /v1/analytics/retention-grid/:tenure/:recency/contacts  contacts in a cell
 *   GET /v1/analytics/retention-grid/:tenure/:recency/trend     daily cell population
 *
 * Both take ?days=<1..90> (default 30). Aggregation happens in Postgres;
 * no rows are shipped to the client for counting.
 *
 * What the data supports, honestly:
 *   - Distribution is CURRENT state only (contacts.lifecycle_state). There
 *     are no historical snapshots, so "distribution over time" cannot be
 *     served and is not approximated here.
 *   - Movement comes from lifecycle_transitions, which records every state
 *     change. Per-day movement, per-state entries/exits, and state-to-state
 *     edges are all exact.
 *   - Retention-grid cell counts are current state; the per-cell trend comes
 *     from retention_grid_snapshots, written once per UTC day by the
 *     grid-snapshot worker. History starts the day the job first runs; it is
 *     not backfilled.
 *   - Sends are counted on sent_at IS NOT NULL ("what went out").
 *   - Opens, clicks and bounces: cumulative totals come from the advance-only
 *     feedback column. Per-day TRENDS now come from the message_events table
 *     (added in migration 0021), which records timestamped delivery events.
 *     The trends only cover messages that have event rows - older messages
 *     predating the table have no events and are not included in trends.
 *
 * Query cost against today's indexes:
 *   - distribution: uses idx_contacts_tenant_state (tenant_id,
 *     lifecycle_state). Cheap.
 *   - movement: uses idx_transitions_tenant_time (tenant_id,
 *     transitioned_at), added in migration 0018.
 *   - sending: uses idx_messages_tenant_sent (tenant_id, sent_at)
 *     WHERE sent_at IS NOT NULL, added in migration 0018.
 *   - engagement trends: uses idx_message_events_tenant_type_day
 *     (tenant_id, event_type, occurred_at).
 */
import { z } from "zod";
import { storeFor } from "@claros/store";
import {
  resolveLifecycleConfig,
  recencyThresholdDays,
  tenureBucketRange,
  recencyBucketRange,
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  RETENTION_TENURE_THRESHOLDS_DAYS,
  type LifecycleConfig,
} from "@claros/core";
import type { Db } from "../plugins/db.js";
import type { AppContext } from "../http/env.js";
import { RoleRouter } from "../http/router.js";

const daysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

const cellParamsSchema = z.object({
  tenure: z.enum(RETENTION_TENURE_BUCKETS),
  recency: z.enum(RETENTION_RECENCY_BUCKETS),
});

const cellContactsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Loads the tenant's lifecycle config (drives the grid's recency thresholds). */
async function loadLifecycleConfig(db: Db, tenantId: string): Promise<LifecycleConfig> {
  const settings = (await storeFor(db).apiAnalytics.getTenantSettings({ tenantId })) as
    | Record<string, unknown>
    | null
    | undefined;
  return resolveLifecycleConfig(
    settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
  );
}

function validationError(c: AppContext, issues: z.ZodIssue[]) {
  return c.json(
    {
      error: "Validation failed",
      issues: issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    400,
  );
}

export default function analyticsRoutes() {
  const router = new RoleRouter();
  /**
   * GET /v1/analytics/lifecycle?days=<1..90>
   *
   * Response:
   * {
   *   range_days: number,
   *   contacts_total: number,
   *   distribution: [{ state, total, power, regular, casual, minimal, unset }],
   *   movement: {
   *     per_state: [{ state, entered, exited }],
   *     edges: [{ from_state, to_state, count }],
   *     days: [{ day, count, positive, negative }]
   *   }
   *
   * Day buckets: positive counts transitions INTO activated/engaged/
   * resurrected, negative counts transitions INTO at_risk/dormant/churned.
   * count is the full day's total (a transition into signed_up, or out of
   * a state, belongs to neither bucket).
   * }
   */
  router.get("/lifecycle", "member", async (c) => {
    const parsed = daysQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const days = parsed.data.days ?? 30;

    const store = storeFor(db).apiAnalytics;
    const distribution = await store.lifecycleDistribution({ tenantId });
    const perState = await store.movementPerState({ tenantId, days });
    const edges = await store.movementEdges({ tenantId, days });
    const movementDays = await store.movementDays({ tenantId, days });

    const contactsTotal = distribution.reduce((acc, row) => acc + row.total, 0);

    return c.json({
      range_days: days,
      contacts_total: contactsTotal,
      distribution,
      movement: {
        per_state: perState,
        edges,
        days: movementDays,
      },
    });
  });

  /**
   * GET /v1/analytics/sending?days=<1..90>
   *
   * Sends are counted on sent_at IS NOT NULL. Engagement totals come from
   * the advance-only feedback column: opened counts opened-or-better
   * ('opened', 'clicked'), clicked counts 'clicked', bounced counts
   * 'bounced', complained counts 'complained'. suppressed and failed are
   * terminal message statuses.
   *
    * Response:
    * {
    *   range_days: number,
    *   days: [{ day, sent }],
    *   engagement_days: [{ day, opens, clicks, bounces }],
    *   totals: { sent, opened, clicked, bounced, complained, suppressed, failed },
    *   per_flow: [{ flow_id, flow_name, sent, opened, clicked, bounced,
    *                complained, suppressed, failed }]
    * }
   */
  router.get("/sending", "member", async (c) => {
    const parsed = daysQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const days = parsed.data.days ?? 30;

    const store = storeFor(db).apiAnalytics;
    const sendDays = await store.sendDays({ tenantId, days });
    const totals = await store.sendingTotals({ tenantId, days });
    const perFlow = await store.sendingPerFlow({ tenantId, days });

    // Per-day engagement trends from message_events table.
    // These cover only messages that have event rows (the table was added in
    // migration 0021). Older messages with only a feedback column are not
    // included - the trend shows data from when event tracking started.
    const engagementDays = await store.engagementDays({ tenantId, days });

    // Find the earliest event to communicate the data window honestly
    const engagementSince = await store.earliestEngagementDay({ tenantId });

    return c.json({
      range_days: days,
      days: sendDays,
      engagement_days: engagementDays,
      engagement_since: engagementSince,
      totals: totals ?? {
        sent: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        suppressed: 0,
        failed: 0,
      },
      per_flow: perFlow,
    });
  });

  /**
   * GET /v1/analytics/retention-grid
   *
   * The retention grid read model: contacts bucketed by tenure (age since
   * first_seen_at, calendar-fixed) crossed with recency (quiet time since
   * last_seen_at, in multiples of the tenant's natural_frequency_days).
   * The bucket boundaries mirror packages/core retention-grid.ts exactly,
   * so a cell here and the audience of a segment-trigger flow are the
   * same set.
   *
   * Response:
   * {
   *   natural_frequency_days: number,
   *   tenure_thresholds_days: { growing, established, loyal },
   *   recency_thresholds_days: { cooling, idle, dormant },
   *   cells: [{ tenure, recency, count, paying }],
   *   contacts_total: number
   * }
   */
  router.get("/retention-grid", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const config = await loadLifecycleConfig(db, tenantId);
    const recencyDays = recencyThresholdDays(config.natural_frequency_days);

    const cells = await storeFor(db).apiAnalytics.retentionGridCells({
      tenantId,
      tenureThresholdsDays: RETENTION_TENURE_THRESHOLDS_DAYS,
      recencyThresholdsDays: recencyDays,
    });

    return c.json({
      natural_frequency_days: config.natural_frequency_days,
      tenure_thresholds_days: RETENTION_TENURE_THRESHOLDS_DAYS,
      recency_thresholds_days: recencyDays,
      cells,
      contacts_total: cells.reduce((acc, cell) => acc + cell.count, 0),
    });
  });

  /**
   * GET /v1/analytics/retention-grid/:tenure/:recency/contacts?cursor=<id>&limit=<1..100>
   *
   * The contacts currently sitting in one grid cell. Uses the same core
   * bucket-range functions as the grid aggregate and segment enrollment, so
   * the list here and the audience of a segment flow for this cell are the
   * same set by construction. Keyset-paginated on contacts.id, ascending.
   *
   * Response:
   * {
   *   contacts: [{ id, external_id, email, name, lifecycle_state,
   *                payment_status, first_seen_at, last_seen_at }],
   *   next_cursor: string | null
   * }
   */
  router.get("/retention-grid/:tenure/:recency/contacts", "member", async (c) => {
    const params = cellParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return validationError(c, params.error.issues);
    }
    const query = cellContactsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return validationError(c, query.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const limit = query.data.limit ?? 50;

    const config = await loadLifecycleConfig(db, tenantId);
    const tenure = tenureBucketRange(params.data.tenure);
    const recency = recencyBucketRange(
      params.data.recency,
      config.natural_frequency_days,
    );

    const rows = await storeFor(db).apiAnalytics.retentionCellContacts({
      tenantId,
      tenure,
      recency,
      afterId: query.data.cursor ?? null,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return c.json({
      contacts: page,
      next_cursor: hasMore ? page[page.length - 1]!.id : null,
    });
  });

  /**
   * GET /v1/analytics/retention-grid/:tenure/:recency/trend?days=<1..90>
   *
   * Daily population of one grid cell from retention_grid_snapshots,
   * ascending by day. History starts the day the grid-snapshot job first
   * runs; it is not backfilled. The current (live) count is NOT included -
   * the grid endpoint serves that; clients may append it as the last point.
   *
   * Response: { range_days: number, days: [{ day, count, paying }] }
   */
  router.get("/retention-grid/:tenure/:recency/trend", "member", async (c) => {
    const params = cellParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return validationError(c, params.error.issues);
    }
    const query = daysQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return validationError(c, query.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const days = query.data.days ?? 30;

    const rows = await storeFor(db).apiAnalytics.retentionCellTrend({
      tenantId,
      tenure: params.data.tenure,
      recency: params.data.recency,
      days,
    });

    return c.json({ range_days: days, days: rows });
  });
  return router.app;
}
