/**
 * Queries used by packages/worker/src/scan-segment-enrollment.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-segment-enrollment.ts (Postgres) and, later,
 * ../d1/worker-scan-segment-enrollment.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerScanSegmentEnrollmentQueries {}
