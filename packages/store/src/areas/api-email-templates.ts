/**
 * Queries used by packages/api/src/routes/email-templates.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-email-templates.ts (Postgres) and, later,
 * ../d1/api-email-templates.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ApiEmailTemplatesQueries {}
