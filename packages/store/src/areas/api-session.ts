/**
 * Queries used by packages/api/src/http/session.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-session.ts (Postgres) and, later,
 * ../d1/api-session.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A session joined with its tenant and user. */
export interface SessionLookupRow {
  sessionUserId: string;
  sessionExpiresAt: Date;
  tenantId: string;
  tenantSlug: string;
  userRole: string;
  userDeactivatedAt: Date | null;
}

export interface ApiSessionQueries {
  /** Session + tenant + user for a session id (null when the session, its tenant or its user is missing). */
  findSessionWithTenantAndUser(sessionId: string): Promise<SessionLookupRow | null>;
}
