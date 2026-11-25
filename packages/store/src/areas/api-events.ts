/**
 * Queries used by packages/api/src/routes/events.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-events.ts (Postgres) and, later,
 * ../d1/api-events.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface ApiEventsQueries {
  /** Distinct track event names received in the last 6 months, most frequent first, at most 200. */
  listRecentTrackEventNames(tenantId: string): Promise<string[]>;
}
