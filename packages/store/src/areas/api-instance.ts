/**
 * Queries used by packages/api/src/routes/instance.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-instance.ts (Postgres) and, later,
 * ../d1/api-instance.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 *
 * Instance-level data is not product-owned: these queries are not tenant
 * scoped and are reachable by instance admins only.
 */

export interface InstanceSettingRow {
  key: string;
  value: unknown;
  updatedAt: Date | null;
}

export interface InstanceUserRow {
  id: string;
  email: string;
  name: string | null;
  instanceRole: string | null;
  /** users.tenant_id: the user's home product. */
  homeTenantId: string;
  deactivatedAt: Date | null;
  createdAt: Date | null;
  /** Membership rows of the user, product slug order. */
  memberships: Array<{ tenantId: string; slug: string; role: string }>;
}

export interface ApiInstanceQueries {
  /** Every instance setting, key order. */
  listSettings(): Promise<InstanceSettingRow[]>;
  /** Insert or replace an instance setting and return it. */
  putSetting(args: { key: string; value: unknown; now: Date }): Promise<InstanceSettingRow>;
  /** Every user of the instance with their memberships, oldest first. */
  listUsers(): Promise<InstanceUserRow[]>;
}
