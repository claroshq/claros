/**
 * Queries used by packages/worker/src/index.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-index.ts (Postgres) and, later,
 * ../d1/worker-index.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface WorkerIndexQueries {
  /** Settings of one (arbitrary, first returned) tenant, or null when no tenant exists. */
  getAnyTenantSettings(): Promise<{ settings: unknown } | null>;
}
