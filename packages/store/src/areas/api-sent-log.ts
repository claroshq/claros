/**
 * Queries used by packages/api/src/routes/sent-log.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-sent-log.ts (Postgres) and, later,
 * ../d1/api-sent-log.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ApiSentLogQueries {}
