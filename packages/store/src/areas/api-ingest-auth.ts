/**
 * Queries used by packages/api/src/http/ingest-auth.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-ingest-auth.ts (Postgres) and, later,
 * ../d1/api-ingest-auth.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A non-revoked API key as the ingestion auth step needs it. */
export interface ActiveApiKeyRow {
  id: string;
  tenantId: string;
  kind: string;
  allowedOrigins: string[] | null;
}

export interface ApiIngestAuthQueries {
  /**
   * The non-revoked ingestion key (kind publishable or secret, bound to a
   * tenant) with this SHA-256 hash, or null. Admin and instance keys never
   * match.
   */
  findActiveKeyByHash(keyHash: string): Promise<ActiveApiKeyRow | null>;
  /** Set last_used_at on an API key. */
  touchKeyLastUsed(apiKeyId: string, at: Date): Promise<void>;
}
