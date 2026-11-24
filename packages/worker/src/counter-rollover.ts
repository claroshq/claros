/**
 * Counter rollover worker - rotates engagement event count buckets.
 *
 * Runs every scan tick (15 min) but only actually rolls contacts whose
 * last_counter_reset_at is older than 15 days (or NULL, meaning never reset).
 * The rotation shifts current bucket counts into the previous-bucket column
 * and zeroes the current bucket, giving downstream queries a sliding two-bucket
 * window of event activity without needing expensive COUNT(*) over events.
 *
 * The 15-day bucket width is a fixed constant (not tenant-configurable).
 * Running every tick is cheap: the WHERE clause ensures only eligible contacts
 * are touched, and the UPDATE is a single round-trip regardless of how many
 * contacts qualify.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface CounterRolloverResult {
  contactsRolled: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Rotates engagement counter buckets for contacts whose current bucket
 * has aged past 15 days.
 *
 * Single UPDATE statement: prev = current, current = 0, reset timestamp = now.
 * Only touches rows where last_counter_reset_at is NULL (never reset) or
 * older than 15 days from `now`.
 */
export async function processCounterRollover(
  db: Db,
  now: Date,
): Promise<CounterRolloverResult> {
  const result = await db.execute(sql`
    UPDATE contacts
    SET
      event_count_bucket_prev = event_count_bucket_current,
      event_count_bucket_current = 0,
      last_counter_reset_at = ${now}
    WHERE last_counter_reset_at IS NULL
       OR last_counter_reset_at < ${now}::timestamptz - interval '15 days'
  `);

  return { contactsRolled: result.rowCount ?? 0 };
}
