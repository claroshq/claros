/**
 * Postgres implementation of the queries used by packages/worker/src/counter-rollover.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { WorkerCounterRolloverQueries } from "../areas/worker-counter-rollover.js";

export function pgWorkerCounterRollover(db: PgDb): WorkerCounterRolloverQueries {
  return {
    async rollEngagementCounters(now) {
      const result = await db.execute(sql`
        UPDATE contacts
        SET
          event_count_bucket_prev = event_count_bucket_current,
          event_count_bucket_current = 0,
          last_counter_reset_at = ${now}
        WHERE last_counter_reset_at IS NULL
           OR last_counter_reset_at < ${now}::timestamptz - interval '15 days'
      `);
      return result.rowCount ?? 0;
    },
  };
}
