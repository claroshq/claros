/**
 * Queries used by apps/server/src/main.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/server-main.ts (Postgres) and, later,
 * ../d1/server-main.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServerMainQueries {}
