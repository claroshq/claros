/**
 * Queries used by packages/worker/src/counter-rollover.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-counter-rollover.ts (Postgres) and, later,
 * ../d1/worker-counter-rollover.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface WorkerCounterRolloverQueries {
  /** Shift current engagement buckets to prev and zero current for contacts not reset in 15 days; returns rows updated. */
  rollEngagementCounters(now: Date): Promise<number>;
}
