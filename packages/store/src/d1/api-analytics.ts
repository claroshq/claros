/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-analytics.ts.
 *
 * Differences from the Postgres SQL, same results:
 * - count(*) FILTER (WHERE x) -> count(CASE WHEN x THEN 1 END) (0, not NULL,
 *   over no rows, like count).
 * - now() - make_interval(days => n) is computed in JS (Date.now()) and bound
 *   as ms; the database clock is the Worker clock on D1.
 * - date_trunc('day', ts)::date::text -> strftime('%Y-%m-%d', ts / 1000,
 *   'unixepoch'): the UTC calendar day, as Postgres with session TimeZone UTC.
 * - retention_grid_snapshots.snapshot_date is 'YYYY-MM-DD' text; the window
 *   start (UTC today - days) is computed in JS and compared as text.
 * - Integer ms timestamps are returned as Date.
 */
import { sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { ApiAnalyticsQueries, SendingCounts } from "../areas/api-analytics.js";

const DAY_MS = 86_400_000;

function toDate(v: unknown): Date | null {
  return v === null || v === undefined ? null : new Date(Number(v));
}

/** ms timestamp of now() - n days. */
function daysAgo(days: number): number {
  return Date.now() - days * DAY_MS;
}

const DAY_OF = (col: string) => sql.raw(`strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`);

export function d1ApiAnalytics(db: D1Db): ApiAnalyticsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const rows = await db.all<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      const s = rows[0]?.settings;
      return typeof s === "string" ? JSON.parse(s) : (s ?? null);
    },

    async lifecycleDistribution({ tenantId }) {
      return db.all(sql`
        SELECT lifecycle_state AS state,
               count(*) AS total,
               count(CASE WHEN engagement_depth = 'power' THEN 1 END) AS power,
               count(CASE WHEN engagement_depth = 'regular' THEN 1 END) AS regular,
               count(CASE WHEN engagement_depth = 'casual' THEN 1 END) AS casual,
               count(CASE WHEN engagement_depth = 'minimal' THEN 1 END) AS minimal,
               count(CASE WHEN engagement_depth IS NULL THEN 1 END) AS unset
        FROM contacts
        WHERE tenant_id = ${tenantId}
        GROUP BY lifecycle_state
      `);
    },

    async movementPerState({ tenantId, days }) {
      const since = daysAgo(days);
      return db.all(sql`
        SELECT state, sum(entered) AS entered, sum(exited) AS exited
        FROM (
          SELECT to_state AS state, 1 AS entered, 0 AS exited
          FROM lifecycle_transitions
          WHERE tenant_id = ${tenantId} AND transitioned_at >= ${since}
          UNION ALL
          SELECT from_state AS state, 0 AS entered, 1 AS exited
          FROM lifecycle_transitions
          WHERE tenant_id = ${tenantId} AND transitioned_at >= ${since}
        ) io
        GROUP BY state
      `);
    },

    async movementEdges({ tenantId, days }) {
      return db.all(sql`
        SELECT from_state, to_state, count(*) AS count
        FROM lifecycle_transitions
        WHERE tenant_id = ${tenantId}
          AND transitioned_at >= ${daysAgo(days)}
        GROUP BY from_state, to_state
        ORDER BY count DESC
        LIMIT 20
      `);
    },

    async movementDays({ tenantId, days }) {
      return db.all(sql`
        SELECT ${DAY_OF("transitioned_at")} AS day,
               count(*) AS count,
               count(CASE WHEN to_state IN ('activated', 'engaged', 'resurrected') THEN 1 END) AS positive,
               count(CASE WHEN to_state IN ('at_risk', 'dormant', 'churned') THEN 1 END) AS negative
        FROM lifecycle_transitions
        WHERE tenant_id = ${tenantId}
          AND transitioned_at >= ${daysAgo(days)}
        GROUP BY 1
        ORDER BY 1
      `);
    },

    async sendDays({ tenantId, days }) {
      return db.all(sql`
        SELECT ${DAY_OF("sent_at")} AS day,
               count(*) AS sent
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND sent_at IS NOT NULL
          AND sent_at >= ${daysAgo(days)}
        GROUP BY 1
        ORDER BY 1
      `);
    },

    async sendingTotals({ tenantId, days }) {
      const rows = await db.all<SendingCounts>(sql`
        SELECT count(CASE WHEN sent_at IS NOT NULL THEN 1 END) AS sent,
               count(CASE WHEN feedback IN ('opened', 'clicked') THEN 1 END) AS opened,
               count(CASE WHEN feedback = 'clicked' THEN 1 END) AS clicked,
               count(CASE WHEN feedback = 'bounced' THEN 1 END) AS bounced,
               count(CASE WHEN feedback = 'complained' THEN 1 END) AS complained,
               count(CASE WHEN status = 'suppressed' THEN 1 END) AS suppressed,
               count(CASE WHEN status = 'failed' THEN 1 END) AS failed
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND created_at >= ${daysAgo(days)}
      `);
      return rows[0] ?? null;
    },

    async sendingPerFlow({ tenantId, days }) {
      return db.all(sql`
        SELECT m.flow_id, f.name AS flow_name,
               count(CASE WHEN m.sent_at IS NOT NULL THEN 1 END) AS sent,
               count(CASE WHEN m.feedback IN ('opened', 'clicked') THEN 1 END) AS opened,
               count(CASE WHEN m.feedback = 'clicked' THEN 1 END) AS clicked,
               count(CASE WHEN m.feedback = 'bounced' THEN 1 END) AS bounced,
               count(CASE WHEN m.feedback = 'complained' THEN 1 END) AS complained,
               count(CASE WHEN m.status = 'suppressed' THEN 1 END) AS suppressed,
               count(CASE WHEN m.status = 'failed' THEN 1 END) AS failed
        FROM lifecycle_messages m
        JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId}
          AND m.created_at >= ${daysAgo(days)}
        GROUP BY m.flow_id, f.name
        ORDER BY sent DESC
        LIMIT 100
      `);
    },

    async engagementDays({ tenantId, days }) {
      return db.all(sql`
        SELECT ${DAY_OF("occurred_at")} AS day,
               count(CASE WHEN event_type = 'opened' THEN 1 END) AS opens,
               count(CASE WHEN event_type = 'clicked' THEN 1 END) AS clicks,
               count(CASE WHEN event_type = 'bounced' THEN 1 END) AS bounces
        FROM message_events
        WHERE tenant_id = ${tenantId}
          AND event_type IN ('opened', 'clicked', 'bounced')
          AND occurred_at >= ${daysAgo(days)}
        GROUP BY 1
        ORDER BY 1
      `);
    },

    async earliestEngagementDay({ tenantId }) {
      const rows = await db.all<{ earliest: string | null }>(sql`
        SELECT ${DAY_OF("min(occurred_at)")} AS earliest
        FROM message_events
        WHERE tenant_id = ${tenantId}
      `);
      return rows[0]?.earliest ?? null;
    },

    async retentionGridCells({ tenantId, tenureThresholdsDays: t, recencyThresholdsDays: r }) {
      const now = Date.now();
      const ago = (days: number) => now - days * DAY_MS;
      return db.all(sql`
        SELECT
          CASE
            WHEN first_seen_at >= ${ago(t.growing)} THEN 'new'
            WHEN first_seen_at >= ${ago(t.established)} THEN 'growing'
            WHEN first_seen_at >= ${ago(t.loyal)} THEN 'established'
            ELSE 'loyal'
          END AS tenure,
          CASE
            WHEN last_seen_at >= ${ago(r.cooling)} THEN 'active'
            WHEN last_seen_at >= ${ago(r.idle)} THEN 'cooling'
            WHEN last_seen_at >= ${ago(r.dormant)} THEN 'idle'
            ELSE 'dormant'
          END AS recency,
          count(*) AS count,
          count(CASE WHEN payment_status IN ('paid', 'past_due') THEN 1 END) AS paying
        FROM contacts
        WHERE tenant_id = ${tenantId}
        GROUP BY 1, 2
      `);
    },

    async retentionCellContacts({ tenantId, tenure, recency, afterId, limit }) {
      const now = Date.now();
      const ago = (days: number) => now - days * DAY_MS;
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, external_id, email, name, lifecycle_state, payment_status,
               first_seen_at, last_seen_at
        FROM contacts
        WHERE tenant_id = ${tenantId}
          AND first_seen_at <= ${ago(tenure.minDays)}
          ${tenure.maxDays === null ? sql`` : sql`AND first_seen_at > ${ago(tenure.maxDays)}`}
          AND last_seen_at <= ${ago(recency.minDays)}
          ${recency.maxDays === null ? sql`` : sql`AND last_seen_at > ${ago(recency.maxDays)}`}
          ${afterId === null ? sql`` : sql`AND id > ${afterId.toLowerCase()}`}
        ORDER BY id
        LIMIT ${limit}
      `);
      return rows.map((row) => ({
        ...row,
        first_seen_at: toDate(row.first_seen_at),
        last_seen_at: toDate(row.last_seen_at),
      })) as unknown as Awaited<ReturnType<ApiAnalyticsQueries["retentionCellContacts"]>>;
    },

    async retentionCellTrend({ tenantId, tenure, recency, days }) {
      // snapshot_date > (UTC today) - days
      const todayUtc = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const cutoff = new Date(todayUtc - days * DAY_MS).toISOString().slice(0, 10);
      return db.all(sql`
        SELECT snapshot_date AS day,
               contact_count AS count,
               paying_count AS paying
        FROM retention_grid_snapshots
        WHERE tenant_id = ${tenantId}
          AND tenure_bucket = ${tenure}
          AND recency_bucket = ${recency}
          AND snapshot_date > ${cutoff}
        ORDER BY snapshot_date
      `);
    },
  };
}
