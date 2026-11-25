/**
 * Postgres implementation of the queries used by packages/api/src/routes/events.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiEventsQueries } from "../areas/api-events.js";

export function pgApiEvents(db: PgDb): ApiEventsQueries {
  return {
    async listRecentTrackEventNames(tenantId) {
      // The received_at range keeps the scan on the recent monthly partitions
      // (events is PARTITION BY RANGE (received_at)); tenant_id is always the
      // first filter.
      const rows = (
        await db.execute<{ event_name: string }>(sql`
          SELECT event_name
          FROM events
          WHERE tenant_id = ${tenantId}
            AND type = 'track'
            AND event_name IS NOT NULL
            AND received_at >= now() - interval '6 months'
          GROUP BY event_name
          ORDER BY count(*) DESC, event_name ASC
          LIMIT 200
        `)
      ).rows;
      return rows.map((row) => row.event_name);
    },
  };
}
