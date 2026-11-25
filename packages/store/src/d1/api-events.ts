/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-events.ts.
 */
import { sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { ApiEventsQueries } from "../areas/api-events.js";

/**
 * `now - interval '6 months'` as Postgres computes it in a UTC session:
 * calendar months back, day clamped to the last day of the target month.
 */
export function sixMonthsBefore(now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - 6;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export function d1ApiEvents(db: D1Db): ApiEventsQueries {
  return {
    async listRecentTrackEventNames(tenantId) {
      const cutoff = sixMonthsBefore(new Date()).getTime();
      const rows = await db.all<{ event_name: string }>(sql`
        SELECT event_name
        FROM events
        WHERE tenant_id = ${tenantId}
          AND type = 'track'
          AND event_name IS NOT NULL
          AND received_at >= ${cutoff}
        GROUP BY event_name
        ORDER BY count(*) DESC, event_name ASC
        LIMIT 200
      `);
      return rows.map((row) => row.event_name);
    },
  };
}
