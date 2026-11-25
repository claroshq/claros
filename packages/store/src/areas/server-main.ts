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
   * inserts) and, when ownerEmail is given, its owner user (ON CONFLICT DO NOTHING).
   */
  bootstrapSeed(ownerEmail: string | null): Promise<BootstrapSeedResult>;
  /** True when at least one user exists. */
  hasAnyUser(): Promise<boolean>;
}
