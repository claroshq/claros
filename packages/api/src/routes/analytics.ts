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
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
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
  const tenantRows = await db.execute<{ settings: unknown }>(sql`
    SELECT settings FROM tenants WHERE id = ${tenantId}
  `);
  const settings = tenantRows.rows[0]?.settings as
    | Record<string, unknown>
    | null
    | undefined;
  return resolveLifecycleConfig(
    settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
  );
}

function validationError(reply: any, issues: z.ZodIssue[]) {
  reply.status(400);
  return {
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

const analyticsRoutes: FastifyPluginAsync = async (app) => {
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
  app.get<{ Querystring: { days?: string } }>("/lifecycle", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = daysQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const days = parsed.data.days ?? 30;

    const distribution = (
      await db.execute<{
        state: string;
        total: number;
        power: number;
        regular: number;
        casual: number;
        minimal: number;
        unset: number;
      }>(sql`
        SELECT lifecycle_state AS state,
               count(*)::int AS total,
               count(*) FILTER (WHERE engagement_depth = 'power')::int AS power,
               count(*) FILTER (WHERE engagement_depth = 'regular')::int AS regular,
               count(*) FILTER (WHERE engagement_depth = 'casual')::int AS casual,
               count(*) FILTER (WHERE engagement_depth = 'minimal')::int AS minimal,
               count(*) FILTER (WHERE engagement_depth IS NULL)::int AS unset
        FROM contacts
        WHERE tenant_id = ${tenantId}
        GROUP BY lifecycle_state
      `)
    ).rows;

    const perState = (
      await db.execute<{ state: string; entered: number; exited: number }>(sql`
        SELECT state, sum(entered)::int AS entered, sum(exited)::int AS exited
        FROM (
          SELECT to_state AS state, count(*) AS entered, 0 AS exited
          FROM lifecycle_transitions
          WHERE tenant_id = ${tenantId}
            AND transitioned_at >= now() - make_interval(days => ${days})
          GROUP BY to_state
          UNION ALL
          SELECT from_state AS state, 0 AS entered, count(*) AS exited
          FROM lifecycle_transitions
          WHERE tenant_id = ${tenantId}
            AND transitioned_at >= now() - make_interval(days => ${days})
          GROUP BY from_state
        ) io
        GROUP BY state
      `)
    ).rows;

    const edges = (
      await db.execute<{ from_state: string; to_state: string; count: number }>(sql`
        SELECT from_state, to_state, count(*)::int AS count
        FROM lifecycle_transitions
        WHERE tenant_id = ${tenantId}
          AND transitioned_at >= now() - make_interval(days => ${days})
        GROUP BY from_state, to_state
        ORDER BY count DESC
        LIMIT 20
      `)
    ).rows;

    const movementDays = (
      await db.execute<{
        day: string;
        count: number;
        positive: number;
        negative: number;
      }>(sql`
        SELECT date_trunc('day', transitioned_at)::date::text AS day,
               count(*)::int AS count,
               count(*) FILTER (
                 WHERE to_state IN ('activated', 'engaged', 'resurrected')
               )::int AS positive,
               count(*) FILTER (
                 WHERE to_state IN ('at_risk', 'dormant', 'churned')
               )::int AS negative
        FROM lifecycle_transitions
        WHERE tenant_id = ${tenantId}
          AND transitioned_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY 1
      `)
    ).rows;

    const contactsTotal = distribution.reduce((acc, row) => acc + row.total, 0);

    return {
      range_days: days,
      contacts_total: contactsTotal,
      distribution,
      movement: {
        per_state: perState,
        edges,
        days: movementDays,
      },
    };
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
  app.get<{ Querystring: { days?: string } }>("/sending", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = daysQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const days = parsed.data.days ?? 30;

    const sendDays = (
      await db.execute<{ day: string; sent: number }>(sql`
        SELECT date_trunc('day', sent_at)::date::text AS day,
               count(*)::int AS sent
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND sent_at IS NOT NULL
          AND sent_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY 1
      `)
    ).rows;

    const totalsRows = (
      await db.execute<{
        sent: number;
        opened: number;
        clicked: number;
        bounced: number;
        complained: number;
        suppressed: number;
        failed: number;
      }>(sql`
        SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
               count(*) FILTER (WHERE feedback IN ('opened', 'clicked'))::int AS opened,
               count(*) FILTER (WHERE feedback = 'clicked')::int AS clicked,
               count(*) FILTER (WHERE feedback = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE feedback = 'complained')::int AS complained,
               count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
               count(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND created_at >= now() - make_interval(days => ${days})
      `)
    ).rows;

    const perFlow = (
      await db.execute<{
        flow_id: string;
        flow_name: string;
        sent: number;
        opened: number;
        clicked: number;
        bounced: number;
        complained: number;
        suppressed: number;
        failed: number;
      }>(sql`
        SELECT m.flow_id, f.name AS flow_name,
               count(*) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent,
               count(*) FILTER (WHERE m.feedback IN ('opened', 'clicked'))::int AS opened,
               count(*) FILTER (WHERE m.feedback = 'clicked')::int AS clicked,
               count(*) FILTER (WHERE m.feedback = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE m.feedback = 'complained')::int AS complained,
               count(*) FILTER (WHERE m.status = 'suppressed')::int AS suppressed,
               count(*) FILTER (WHERE m.status = 'failed')::int AS failed
        FROM lifecycle_messages m
        JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId}
          AND m.created_at >= now() - make_interval(days => ${days})
        GROUP BY m.flow_id, f.name
        ORDER BY sent DESC
        LIMIT 100
      `)
    ).rows;

    // Per-day engagement trends from message_events table.
    // These cover only messages that have event rows (the table was added in
    // migration 0021). Older messages with only a feedback column are not
    // included - the trend shows data from when event tracking started.
    const engagementDays = (
      await db.execute<{ day: string; opens: number; clicks: number; bounces: number }>(sql`
        SELECT date_trunc('day', occurred_at)::date::text AS day,
               count(*) FILTER (WHERE event_type = 'opened')::int AS opens,
               count(*) FILTER (WHERE event_type = 'clicked')::int AS clicks,
               count(*) FILTER (WHERE event_type = 'bounced')::int AS bounces
        FROM message_events
        WHERE tenant_id = ${tenantId}
          AND event_type IN ('opened', 'clicked', 'bounced')
          AND occurred_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY 1
      `)
    ).rows;

    // Find the earliest event to communicate the data window honestly
    const earliestEvent = (
      await db.execute<{ earliest: string | null }>(sql`
        SELECT min(occurred_at)::date::text AS earliest
        FROM message_events
        WHERE tenant_id = ${tenantId}
        LIMIT 1
      `)
    ).rows;

    return {
      range_days: days,
      days: sendDays,
      engagement_days: engagementDays,
      engagement_since: earliestEvent[0]?.earliest ?? null,
      totals: totalsRows[0] ?? {
        sent: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        suppressed: 0,
        failed: 0,
      },
      per_flow: perFlow,
    };
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
  app.get("/retention-grid", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const config = await loadLifecycleConfig(db, tenantId);
    const recencyDays = recencyThresholdDays(config.natural_frequency_days);

    const cells = (
      await db.execute<Record<string, unknown> & {
        tenure: string;
        recency: string;
        count: number;
        paying: number;
      }>(sql`
        SELECT
          CASE
            WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.growing}) THEN 'new'
            WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.established}) THEN 'growing'
            WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.loyal}) THEN 'established'
            ELSE 'loyal'
          END AS tenure,
          CASE
            WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.cooling}) THEN 'active'
            WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.idle}) THEN 'cooling'
            WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.dormant}) THEN 'idle'
            ELSE 'dormant'
          END AS recency,
          count(*)::int AS count,
          count(*) FILTER (WHERE payment_status IN ('paid', 'past_due'))::int AS paying
        FROM contacts
        WHERE tenant_id = ${tenantId}
        GROUP BY 1, 2
      `)
    ).rows;

    return {
      natural_frequency_days: config.natural_frequency_days,
      tenure_thresholds_days: RETENTION_TENURE_THRESHOLDS_DAYS,
      recency_thresholds_days: recencyDays,
      cells,
      contacts_total: cells.reduce((acc, c) => acc + c.count, 0),
    };
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
  app.get<{
    Params: { tenure: string; recency: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/retention-grid/:tenure/:recency/contacts", { config: { minRole: "member" } }, async (request, reply) => {
    const params = cellParamsSchema.safeParse(request.params);
    if (!params.success) {
      return validationError(reply, params.error.issues);
    }
    const query = cellContactsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return validationError(reply, query.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const limit = query.data.limit ?? 50;

    const config = await loadLifecycleConfig(db, tenantId);
    const tenure = tenureBucketRange(params.data.tenure);
    const recency = recencyBucketRange(
      params.data.recency,
      config.natural_frequency_days,
    );

    const rows = (
      await db.execute<{
        id: string;
        external_id: string;
        email: string | null;
        name: string | null;
        lifecycle_state: string;
        payment_status: string | null;
        first_seen_at: string | null;
        last_seen_at: string | null;
      }>(sql`
        SELECT id, external_id, email, name, lifecycle_state, payment_status,
               first_seen_at, last_seen_at
        FROM contacts
        WHERE tenant_id = ${tenantId}
          AND first_seen_at <= now() - make_interval(days => ${tenure.minDays})
          AND (${tenure.maxDays}::int IS NULL OR first_seen_at > now() - make_interval(days => ${tenure.maxDays}))
          AND last_seen_at <= now() - make_interval(days => ${recency.minDays})
          AND (${recency.maxDays}::int IS NULL OR last_seen_at > now() - make_interval(days => ${recency.maxDays}))
          AND (${query.data.cursor ?? null}::uuid IS NULL OR id > ${query.data.cursor ?? null}::uuid)
        ORDER BY id
        LIMIT ${limit + 1}
      `)
    ).rows;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      contacts: page,
      next_cursor: hasMore ? page[page.length - 1]!.id : null,
    };
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
  app.get<{
    Params: { tenure: string; recency: string };
    Querystring: { days?: string };
  }>("/retention-grid/:tenure/:recency/trend", { config: { minRole: "member" } }, async (request, reply) => {
    const params = cellParamsSchema.safeParse(request.params);
    if (!params.success) {
      return validationError(reply, params.error.issues);
    }
    const query = daysQuerySchema.safeParse(request.query);
    if (!query.success) {
      return validationError(reply, query.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const days = query.data.days ?? 30;

    const rows = (
      await db.execute<{ day: string; count: number; paying: number }>(sql`
        SELECT snapshot_date::text AS day,
               contact_count AS count,
               paying_count AS paying
        FROM retention_grid_snapshots
        WHERE tenant_id = ${tenantId}
          AND tenure_bucket = ${params.data.tenure}
          AND recency_bucket = ${params.data.recency}
          AND snapshot_date > (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${days})
        ORDER BY snapshot_date
      `)
    ).rows;

    return { range_days: days, days: rows };
  });
};

export default analyticsRoutes;
