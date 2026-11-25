/**
 * Queries used by apps/server/src/main.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/server-main.ts (Postgres) and, later,
 * ../d1/server-main.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Outcome of the bootstrap seed. */
export interface BootstrapSeedResult {
  /** True when no tenant existed at the start (the seed path ran). */
  freshInstall: boolean;
  /** True when this caller inserted the default tenant (false when it lost the race or nothing ran). */
  insertedTenant: boolean;
  /** Id of the default tenant, or null when tenants already existed. */
  tenantId: string | null;
}

export interface ServerMainQueries {
  /**
   * In one transaction: when no tenant exists, insert the "default" tenant
   * (ON CONFLICT DO NOTHING on slug, so exactly one of N concurrent callers
   * inserts) and, when ownerEmail is given, its owner user (ON CONFLICT DO NOTHING),
   * who is an instance admin with an owner membership of the default tenant.
   */
  bootstrapSeed(ownerEmail: string | null): Promise<BootstrapSeedResult>;
  /** True when at least one user exists. */
  hasAnyUser(): Promise<boolean>;
  /**
   * In one transaction: delete every unconsumed claim token, then insert the
   * new one (SHA-256 hex hash). The boot of a server with no user mints a
   * fresh token this way; earlier unconsumed tokens stop working.
   */
  replaceClaimToken(args: { tokenHash: string; expiresAt: Date }): Promise<void>;
}
