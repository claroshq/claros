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

/** An instance key (kind 'instance', no product) as the instance routes list it. */
export interface InstanceKeyRow {
  id: string;
  prefix: string;
  label: string | null;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date | null;
  revokedAt: Date | null;
}

/** A contact of some product with a given email. */
export interface InstancePersonRow {
  tenantId: string;
  tenantSlug: string;
  contactId: string;
  externalId: string;
}

export interface ApiInstanceQueries {
  /** Every instance setting, key order. */
  listSettings(): Promise<InstanceSettingRow[]>;
  /** Insert or replace an instance setting and return it. */
  putSetting(args: { key: string; value: unknown; now: Date }): Promise<InstanceSettingRow>;
  /** Every user of the instance with their memberships, oldest first. */
  listUsers(): Promise<InstanceUserRow[]>;
  /** Every instance key, active and revoked, oldest first. */
  listInstanceKeys(): Promise<InstanceKeyRow[]>;
  /** Insert an instance key (tenant_id null, kind 'instance') and return it. */
  createInstanceKey(args: { keyHash: string; prefix: string; label: string | null; scopes: string[]; now: Date }): Promise<InstanceKeyRow>;
  /**
   * Set revoked_at of the instance key with this id when it is not revoked
   * yet; returns the key (revoked or not), or null when no instance key has
   * this id.
   */
  revokeInstanceKey(args: { id: string; now: Date }): Promise<InstanceKeyRow | null>;
  /**
   * Contacts of every product whose email equals `email` ignoring case
   * (ASCII folding on SQLite), product slug order. Not tenant scoped by
   * design: the caller erases the person per product.
   */
  findPeopleByEmail(email: string): Promise<InstancePersonRow[]>;
}
