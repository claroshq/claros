/**
 * Queries used by packages/api/src/routes/suppressions.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-suppressions.ts (Postgres) and, later,
 * ../d1/api-suppressions.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A suppression row. */
export interface SuppressionRow {
  id: string;
  tenantId: string;
  email: string;
  reason: string;
  source: string | null;
  createdAt: Date | null;
}

export interface ApiSuppressionsQueries {
  /** Suppress one address (reason manual, source admin); false when it was already suppressed (case-insensitive). */
  addManualSuppression(input: { tenantId: string; email: string }): Promise<boolean>;
  /** Bulk-insert imported addresses (reason imported, source csv_import), skipping existing ones case-insensitively; returns the number inserted. */
  importSuppressions(input: { tenantId: string; emails: string[] }): Promise<number>;
  /**
   * One page of the tenant's suppressions ordered by (created_at truncated to
   * milliseconds, id), strictly after the cursor when given.
   */
  listSuppressions(input: {
    tenantId: string;
    after: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<SuppressionRow[]>;
}
