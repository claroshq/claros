/**
 * Queries used by packages/api/src/routes/auth.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-auth.ts (Postgres) and, later,
 * ../d1/api-auth.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface ApiAuthQueries {
  /** Active transport config of the tenant (config as JSON text), or null. */
  findActiveTransportConfig(tenantId: string): Promise<{
    provider: string;
    config: string;
    from_email: string;
    from_name: string | null;
  } | null>;
  /** User with this email in any tenant (login lookup), or null. */
  findUserByEmail(email: string): Promise<{ id: string; tenantId: string; email: string } | null>;
  /** Store a magic link token hash for the user. */
  createMagicLinkToken(args: { tenantId: string; userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  /** True when the tenant has an active transport config. */
  hasActiveTransport(tenantId: string): Promise<boolean>;
  /** Tenant name and settings (brand lives in settings), or null. */
  findTenantBrand(tenantId: string): Promise<{ name: string; settings: unknown } | null>;
  /** Read-only lookup of a magic link token and its user's email (does not consume it). */
  findMagicLinkToken(tokenHash: string): Promise<{ expiresAt: Date; consumedAt: Date | null; email: string } | null>;
  /**
   * Consume a magic link token (CAS on consumed_at IS NULL). Returns the token
   * when this caller consumed it, null when it was already consumed or unknown.
   * Expired tokens are consumed too; the caller checks expiresAt.
   */
  consumeMagicLinkToken(args: { tokenHash: string; now: Date }): Promise<{
    id: string;
    userId: string;
    tenantId: string;
    expiresAt: Date;
  } | null>;
  /** Create a session for the user and return its id. */
  createSession(args: { tenantId: string; userId: string; expiresAt: Date }): Promise<string>;
  /** Stamp the user's last login time. */
  touchUserLastLogin(args: { userId: string; now: Date }): Promise<void>;
  /** Delete a session (logout). */
  deleteSession(sessionId: string): Promise<void>;
  /** Session by id, or null. */
  findSession(sessionId: string): Promise<{ userId: string; tenantId: string; expiresAt: Date } | null>;
  /** User profile by id, or null. */
  findUserById(userId: string): Promise<{ id: string; email: string; name: string | null; role: string } | null>;
}
