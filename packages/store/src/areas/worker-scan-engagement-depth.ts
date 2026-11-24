/**
 * Queries used by packages/worker/src/scan-engagement-depth.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-engagement-depth.ts (Postgres) and, later,
 * ../d1/worker-scan-engagement-depth.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerScanEngagementDepthQueries {}
