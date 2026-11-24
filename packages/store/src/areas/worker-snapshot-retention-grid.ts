/**
 * Queries used by packages/worker/src/snapshot-retention-grid.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-snapshot-retention-grid.ts (Postgres) and, later,
 * ../d1/worker-snapshot-retention-grid.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerSnapshotRetentionGridQueries {}
