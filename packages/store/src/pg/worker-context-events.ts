/**
 * Postgres implementation of the queries used by packages/worker/src/context-events.ts.
 *
 * The events table is partitioned by RANGE (received_at). Every query
 * constrains received_at so the planner can prune partitions; the semantic
 * filter on timestamp is applied in addition.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerContextEventsQueries,
  WorkerRecentEventRow,
} from "../areas/worker-context-events.js";

type CadenceRow = Record<string, unknown> & {
  current_7d: string; // pg COUNT returns bigint as string
  previous_7d: string;
};

type RecentEventRow = Record<string, unknown> & WorkerRecentEventRow;

type FeatureRow = Record<string, unknown> & {
  event_name: string;
  cnt: string; // bigint as string
};

export function pgWorkerContextEvents(db: PgDb): WorkerContextEventsQueries {
  return {
    async countCadenceWindows({ tenantId, contactId, now, w7Start, w14Start, receivedFrom }) {
      // Two COUNT FILTER expressions in a single pass over the relevant partitions.
      // received_at >= rcvAt14Prune prunes all partitions older than 14 days + slack.
      // timestamp filters then apply the precise semantic windows.
      const cadenceRows = await db.execute<CadenceRow>(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE timestamp >= ${w7Start.toISOString()}::timestamptz
              AND timestamp  < ${now.toISOString()}::timestamptz
          ) AS current_7d,
          COUNT(*) FILTER (
            WHERE timestamp >= ${w14Start.toISOString()}::timestamptz
              AND timestamp  < ${w7Start.toISOString()}::timestamptz
          ) AS previous_7d
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND received_at >= ${receivedFrom.toISOString()}::timestamptz
          AND received_at  < ${now.toISOString()}::timestamptz
      `);
      const cadRow = cadenceRows.rows[0]!;
      return { current_7d: cadRow.current_7d, previous_7d: cadRow.previous_7d };
    },

    async listRecentEvents({ tenantId, contactId, receivedFrom, limit }) {
      // Ordering: timestamp DESC, then event_name ASC for deterministic tie-break.
      const recentRows = await db.execute<RecentEventRow>(sql`
        SELECT event_name, timestamp
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND received_at >= ${receivedFrom.toISOString()}::timestamptz
        ORDER BY timestamp DESC, event_name ASC
        LIMIT ${limit}
      `);
      return recentRows.rows;
    },

    async listMostUsedEventNames({ tenantId, contactId, now, since, receivedFrom, limit }) {
      // Excludes null event_name (identify events carry no feature signal).
      // Tie-break: alphabetical ascending on event_name (impl note 13).
      const featureRows = await db.execute<FeatureRow>(sql`
        SELECT event_name, COUNT(*) AS cnt
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND event_name IS NOT NULL
          AND timestamp  >= ${since.toISOString()}::timestamptz
          AND timestamp   < ${now.toISOString()}::timestamptz
          AND received_at >= ${receivedFrom.toISOString()}::timestamptz
          AND received_at  < ${now.toISOString()}::timestamptz
        GROUP BY event_name
        ORDER BY cnt DESC, event_name ASC
        LIMIT ${limit}
      `);
      return featureRows.rows;
    },
  };
}
