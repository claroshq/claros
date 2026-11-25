/**
 * Partition maintenance worker - ensures future monthly partitions exist.
 *
 * Runs every scan tick (15 min). Completely idempotent: checks pg_class for
 * existing partitions and only creates missing ones. Maintains at least 2
 * months of runway ahead of the current month (current + next 2 months).
 *
 * Partition naming follows the pattern: events_y{YYYY}m{MM}
 *   e.g. events_y2026m07, events_y2026m08
 *
 * Each partition covers [start-of-month, start-of-next-month) on received_at.
 * Uses CREATE TABLE IF NOT EXISTS for safety even though we pre-check pg_class,
 * guarding against races if multiple scheduler instances fire concurrently.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PartitionMaintenanceResult {
  partitionsCreated: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a month number as two-digit string (01-12). */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Builds the partition name for a given year and month. */
function partitionName(year: number, month: number): string {
  return `events_y${year}m${pad2(month)}`;
}

/**
 * Returns an array of { year, month } for the current month plus the next
 * `ahead` months.
 */
function targetMonths(now: Date, ahead: number): Array<{ year: number; month: number }> {
  const results: Array<{ year: number; month: number }> = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1; // 1-indexed

  for (let i = 0; i <= ahead; i++) {
    results.push({ year, month });
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Ensures that monthly range partitions exist on the `events` table for the
 * current month and the next 2 months.
 *
 * Returns the names of any partitions that were created during this invocation.
 */
export async function processPartitionMaintenance(
  db: Db,
  now: Date,
): Promise<PartitionMaintenanceResult> {
  const partitionsCreated: string[] = [];
  const months = targetMonths(now, 2);

  for (const { year, month } of months) {
    const name = partitionName(year, month);

    // Check if partition already exists in pg_class.
    if (await storeFor(db).workerPartitionMaintenance.partitionExists(name)) {
      continue;
    }

    // Compute range boundaries: [start, end) where end = start of next month.
    const start = `${year}-${pad2(month)}-01`;
    let endYear = year;
    let endMonth = month + 1;
    if (endMonth > 12) {
      endMonth = 1;
      endYear++;
    }
    const end = `${endYear}-${pad2(endMonth)}-01`;

    // Create the partition. IF NOT EXISTS guards against races.
    await storeFor(db).workerPartitionMaintenance.createEventsPartition({ name, start, end });

    partitionsCreated.push(name);
  }

  return { partitionsCreated };
}
