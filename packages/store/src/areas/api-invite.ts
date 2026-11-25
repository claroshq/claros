/**
 * Queries used by packages/api/src/routes/invite.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-invite.ts (Postgres) and, later,
 * ../d1/api-invite.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface ApiInviteQueries {
  /** Read-only lookup of an invite by token hash (does not consume it). */
  findInviteByTokenHash(tokenHash: string): Promise<{
    email: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    tenantId: string;
  } | null>;
  /** Tenant display name, or null when the tenant does not exist. */
  findTenantName(tenantId: string): Promise<string | null>;
  /**
   * Consume an invite (CAS on accepted_at IS NULL). Returns the invite when
   * this caller consumed it, null when it was already consumed or unknown.
   * Expired invites are consumed too; the caller checks expiresAt.
   */
  consumeInvite(args: { tokenHash: string; now: Date }): Promise<{
    id: string;
    email: string;
    role: string;
    tenantId: string;
    expiresAt: Date;
  } | null>;
  /** User with this email in the tenant (active or deactivated), or null. */
  findUserByEmail(args: { tenantId: string; email: string }): Promise<{ id: string; deactivatedAt: Date | null } | null>;
  /** Reactivate an existing user with the invite's role and stamp the login time. */
  reactivateUser(args: { userId: string; role: string; now: Date }): Promise<void>;
  /** Create a user from an accepted invite and return its id. */
  createUser(args: { tenantId: string; email: string; role: string; now: Date }): Promise<string>;
  /** Create a session for the user and return its id. */
  createSession(args: { tenantId: string; userId: string; expiresAt: Date }): Promise<string>;
}
