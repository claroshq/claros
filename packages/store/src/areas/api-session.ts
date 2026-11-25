/**
 * Queries used by packages/api/src/http/session.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-session.ts (Postgres) and, later,
 * ../d1/api-session.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/**
 * A session joined with its user and the product (tenant) the request acts on.
 */
export interface SessionLookupRow {
  sessionUserId: string;
  sessionExpiresAt: Date;
  tenantId: string;
  tenantSlug: string;
  /**
   * The user's effective role in the product: "owner" for an instance admin,
   * users.role in the user's home product (users.tenant_id), else the
   * membership role.
   */
  userRole: string;
  userDeactivatedAt: Date | null;
  /** users.instance_role: "admin" or null. */
  userInstanceRole: string | null;
  /** tenants.archived_at of the product. */
  tenantArchivedAt: Date | null;
}

export interface ApiSessionQueries {
  /**
   * Session + product + user for a session id, in one query. The product is
   * the one with `productSlug` when given, else the session's tenant. Null
   * when the session, the product or the user is missing, or when the user
   * may not act on the product (no membership row, not their home product,
   * not an instance admin).
   */
  findSessionWithTenantAndUser(sessionId: string, productSlug?: string | null): Promise<SessionLookupRow | null>;
}
