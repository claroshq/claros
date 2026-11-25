/**
 * Queries used by packages/api/src/routes/team.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-team.ts (Postgres) and, later,
 * ../d1/api-team.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

export interface ApiTeamQueries {
  /** Active (not deactivated) members of the tenant, oldest first. */
  listMembers(input: { tenantId: string }): Promise<Array<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    lastLoginAt: Date | null;
    createdAt: Date | null;
  }>>;
  /** True when an active member of the tenant has this email. */
  isActiveMemberEmail(input: { tenantId: string; email: string }): Promise<boolean>;
  /** Create an invite; returns its id. */
  createInvite(input: {
    tenantId: string;
    email: string;
    role: string;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<string>;
  /** Tenant name and settings for branding, or null. */
  getTenantBrand(input: { tenantId: string }): Promise<{ name: string; settings: unknown } | null>;
  /** A user's display name, or null. */
  getUserName(input: { userId: string }): Promise<string | null>;
  /** The tenant's active transport (config as JSON text), or null. */
  getActiveTransport(input: { tenantId: string }): Promise<{
    provider: string;
    config: string;
    from_email: string;
    from_name: string | null;
  } | null>;
  /** Pending (not accepted, not expired) invites of the tenant, oldest first. */
  listPendingInvites(input: { tenantId: string }): Promise<Array<{
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    createdAt: Date | null;
  }>>;
  /** Delete a tenant's invite; false when it was not found. */
  deleteInvite(input: { tenantId: string; id: string }): Promise<boolean>;
  /** An active member of the tenant (id and role), or null. */
  getActiveMember(input: { tenantId: string; userId: string }): Promise<{ id: string; role: string } | null>;
  /** Number of active owners of the tenant. */
  countActiveOwners(input: { tenantId: string }): Promise<number>;
  /** Set a user's role. */
  setRole(input: { userId: string; role: string }): Promise<void>;
  /** Deactivate a user (soft delete), then delete all their sessions. Two statements, not a transaction. */
  deactivateMember(input: { userId: string; now: Date }): Promise<void>;
}
