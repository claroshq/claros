/**
 * Queries used by packages/worker/src/partition-maintenance.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-partition-maintenance.ts (Postgres) and, later,
 * ../d1/worker-partition-maintenance.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 *
 * Partitioning is Postgres-only; the D1 implementation will be a no-op.
 */
export interface WorkerPartitionMaintenanceQueries {
  /** Whether a table (partition) with this name already exists. */
  partitionExists(name: string): Promise<boolean>;
  /**
   * Create the monthly events partition covering [start, end) on received_at
   * (dates as YYYY-MM-DD). Idempotent (IF NOT EXISTS guards against races).
   */
  createEventsPartition(input: { name: string; start: string; end: string }): Promise<void>;
}
