/**
 * Queries used by packages/worker/src/scan-step-advancement.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-step-advancement.ts (Postgres) and, later,
 * ../d1/worker-scan-step-advancement.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerScanStepAdvancementQueries {}
