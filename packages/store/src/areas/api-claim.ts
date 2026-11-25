/**
 * Queries used by packages/api/src/routes/claim.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-claim.ts (Postgres) and, later,
 * ../d1/api-claim.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface ApiClaimQueries {
  /** True when at least one user exists in the install (claim is over). */
  anyUserExists(): Promise<boolean>;
  /** Id of the tenant with slug "default", or null when bootstrap has not run. */
  findDefaultTenantId(): Promise<string | null>;
  /**
   * Insert the owner user; returns its id, or null when the insert hit a
   * conflict (a concurrent claim won the race).
   */
  createOwnerUser(args: { tenantId: string; email: string }): Promise<string | null>;
  /** Create a session for the user and return its id. */
  createSession(args: { tenantId: string; userId: string; expiresAt: Date }): Promise<string>;
}
