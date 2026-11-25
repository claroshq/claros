/**
 * Queries used by packages/api/src/http/admin-auth.ts (G1).
 *
 * Every method is one database operation. Implementations:
 * ../pg/api-admin-auth.ts and ../d1/api-admin-auth.ts.
 */

/** A non-revoked admin key with the product it belongs to. */
export interface ActiveAdminKeyRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantArchivedAt: Date | null;
  scopes: string[];
}

export interface ApiAdminAuthQueries {
  /**
   * The non-revoked admin key (kind 'admin', bound to a product) with this
   * SHA-256 hash, joined to its product, or null. Ingestion and instance
   * keys never match.
   */
  findActiveAdminKeyByHash(keyHash: string): Promise<ActiveAdminKeyRow | null>;
}
