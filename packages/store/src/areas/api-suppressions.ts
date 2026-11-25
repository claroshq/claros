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
    /** Only rows created at or after this time (G12 ?since=). */
    since?: Date | null;
  }): Promise<SuppressionRow[]>;
  /**
   * Suppress addresses with a reason and source (G12 bulk API), skipping
   * existing ones case-insensitively (first occurrence in the list wins).
   * Writes a contact.suppressed outbox entry per inserted address in the
   * same atomic unit. Returns the inserted addresses.
   */
  addSuppressions(input: { tenantId: string; emails: string[]; reason: string; source: string; now: Date }): Promise<string[]>;
  /**
   * Delete the suppression of an address (case-insensitive). Reasons in
   * `protectedReasons` are kept unless `force`. Writes contact.resubscribed
   * with the deletion. "protected" carries the stored reason.
   */
  removeSuppression(input: {
    tenantId: string;
    email: string;
    force: boolean;
    protectedReasons: string[];
    now: Date;
  }): Promise<{ result: "deleted" | "not_found" | "protected"; reason: string | null }>;
}
