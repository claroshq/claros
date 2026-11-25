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
   * In one transaction: insert the owner user (instance admin) and its owner
   * membership of the tenant. Returns the user id, or null when the insert
   * hit a conflict (a concurrent claim won the race).
   */
  createOwnerUser(args: { tenantId: string; email: string }): Promise<string | null>;
  /** Create a session for the user and return its id. */
  createSession(args: { tenantId: string; userId: string; expiresAt: Date }): Promise<string>;
  /**
   * Insert a claim token (SHA-256 hex hash) unless one with the same hash
   * exists (ON CONFLICT DO NOTHING). Seeds the table from a token given to
   * the app directly; a consumed token stays consumed.
   */
  ensureClaimToken(args: { tokenHash: string; expiresAt: Date }): Promise<void>;
  /** True when the token hash exists, is unconsumed and expires after `now`. */
  isClaimTokenValid(args: { tokenHash: string; now: Date }): Promise<boolean>;
  /**
   * Consume the token: atomic CAS (UPDATE ... WHERE consumed_at IS NULL AND
   * expires_at > now). True for exactly one of N concurrent callers.
   */
  consumeClaimToken(args: { tokenHash: string; now: Date }): Promise<boolean>;
}
