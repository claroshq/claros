/**
 * Postgres implementation of the queries used by packages/api/src/routes/analytics.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiAnalyticsQueries, SendingCounts } from "../areas/api-analytics.js";

export function pgApiAnalytics(db: PgDb): ApiAnalyticsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const tenantRows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return tenantRows.rows[0]?.settings ?? null;
    },

    async lifecycleDistribution({ tenantId }) {
      return (
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
    },

    async movementPerState({ tenantId, days }) {
      return (
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
    },

    async movementEdges({ tenantId, days }) {
      return (
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
    },

    async movementDays({ tenantId, days }) {
      return (
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
    },

    async sendDays({ tenantId, days }) {
      return (
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
    },

    async sendingTotals({ tenantId, days }) {
      const totalsRows = (
        await db.execute<SendingCounts>(sql`
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
      return totalsRows[0] ?? null;
    },

    async sendingPerFlow({ tenantId, days }) {
      return (
        await db.execute<SendingCounts & { flow_id: string; flow_name: string }>(sql`
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
    },

    async engagementDays({ tenantId, days }) {
      // Per-day engagement trends from message_events table.
      // These cover only messages that have event rows (the table was added in
      // migration 0021). Older messages with only a feedback column are not
      // included - the trend shows data from when event tracking started.
      return (
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
    },

    async earliestEngagementDay({ tenantId }) {
      const earliestEvent = (
        await db.execute<{ earliest: string | null }>(sql`
          SELECT min(occurred_at)::date::text AS earliest
          FROM message_events
          WHERE tenant_id = ${tenantId}
          LIMIT 1
        `)
      ).rows;
      return earliestEvent[0]?.earliest ?? null;
    },

    async retentionGridCells({ tenantId, tenureThresholdsDays, recencyThresholdsDays: recencyDays }) {
      return (
        await db.execute<Record<string, unknown> & {
          tenure: string;
          recency: string;
          count: number;
          paying: number;
        }>(sql`
          SELECT
            CASE
              WHEN first_seen_at >= now() - make_interval(days => ${tenureThresholdsDays.growing}) THEN 'new'
              WHEN first_seen_at >= now() - make_interval(days => ${tenureThresholdsDays.established}) THEN 'growing'
              WHEN first_seen_at >= now() - make_interval(days => ${tenureThresholdsDays.loyal}) THEN 'established'
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
    },

    async retentionCellContacts({ tenantId, tenure, recency, afterId, limit }) {
      return (
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
            AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
          ORDER BY id
          LIMIT ${limit}
        `)
      ).rows;
    },

    async retentionCellTrend({ tenantId, tenure, recency, days }) {
      return (
        await db.execute<{ day: string; count: number; paying: number }>(sql`
          SELECT snapshot_date::text AS day,
                 contact_count AS count,
                 paying_count AS paying
          FROM retention_grid_snapshots
          WHERE tenant_id = ${tenantId}
            AND tenure_bucket = ${tenure}
            AND recency_bucket = ${recency}
            AND snapshot_date > (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${days})
          ORDER BY snapshot_date
        `)
      ).rows;
    },
  };
}
