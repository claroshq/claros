/**
 * Queries used by packages/api/src/routes/profile.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-profile.ts (Postgres) and, later,
 * ../d1/api-profile.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

export interface ApiProfileQueries {
  /** The user's profile row, or null. */
  getProfile(input: { userId: string }): Promise<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    pendingEmail: string | null;
    pendingEmailExpiresAt: Date | null;
    createdAt: Date | null;
  } | null>;
  /** Set the user's display name. */
  setName(input: { userId: string; name: string | null }): Promise<void>;
  /** The user's current email, or null when the user does not exist. */
  getEmail(input: { userId: string }): Promise<string | null>;
  /** True when a user of the tenant already has this email. */
  isEmailTaken(input: { tenantId: string; email: string }): Promise<boolean>;
  /** Store a pending email change on the user (overwrites any previous one). */
  setPendingEmail(input: { userId: string; pendingEmail: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  /** Tenant name and settings for branding, or null. */
  getTenantBrand(input: { tenantId: string }): Promise<{ name: string; settings: unknown } | null>;
  /** The tenant's active transport (config as JSON text), or null. */
  getActiveTransport(input: { tenantId: string }): Promise<{
    provider: string;
    config: string;
    from_email: string;
    from_name: string | null;
  } | null>;
  /** The user's pending email change, or null when the user does not exist. */
  getPendingEmailChange(input: { userId: string }): Promise<{
    pendingEmail: string | null;
    pendingEmailTokenHash: string | null;
    pendingEmailExpiresAt: Date | null;
  } | null>;
  /** Clear the user's pending email change. */
  clearPendingEmail(input: { userId: string }): Promise<void>;
  /** Swap the user's email to the verified address and clear pending fields in one update. */
  applyEmailChange(input: { userId: string; email: string }): Promise<void>;
}
