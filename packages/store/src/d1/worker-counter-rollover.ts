/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-counter-rollover.ts.
 *
 * The 15-day cutoff (Postgres: now - interval '15 days', session TZ UTC) is computed in code.
 */
import { isNull, lt, or, sql } from "drizzle-orm";
import { contacts } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerCounterRolloverQueries } from "../areas/worker-counter-rollover.js";

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

export function d1WorkerCounterRollover(db: D1Db): WorkerCounterRolloverQueries {
  return {
    async rollEngagementCounters(now) {
      const cutoff = new Date(now.getTime() - FIFTEEN_DAYS_MS);
      const result = await db
        .update(contacts)
        .set({
          eventCountBucketPrev: sql`${contacts.eventCountBucketCurrent}`,
          eventCountBucketCurrent: 0,
          lastCounterResetAt: now,
        })
        .where(or(isNull(contacts.lastCounterResetAt), lt(contacts.lastCounterResetAt, cutoff)))
        .run();
      return result.meta.changes ?? 0;
    },
  };
}
