/**
 * Queries used by packages/worker/src/trigger-check.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-trigger-check.ts (Postgres) and, later,
 * ../d1/worker-trigger-check.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerTriggerCheckQueries {}
