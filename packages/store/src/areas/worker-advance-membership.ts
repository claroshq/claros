/**
 * Queries used by packages/worker/src/advance-membership.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-advance-membership.ts (Postgres) and, later,
 * ../d1/worker-advance-membership.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerAdvanceMembershipQueries {}
