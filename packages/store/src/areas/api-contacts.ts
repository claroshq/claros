/**
 * Queries used by packages/api/src/routes/contacts.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-contacts.ts (Postgres) and, later,
 * ../d1/api-contacts.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Filters for the People list. Null means "no filter". */
export interface ContactListFilter {
  lifecycleState: string | null;
  engagementDepth: string | null;
  /** ILIKE pattern (with % wildcards) on email, name or external_id. */
  searchPattern: string | null;
  /** first_seen_at at least this many days ago. */
  tenureMinDays: number | null;
  /** first_seen_at less than this many days ago. */
  tenureMaxDays: number | null;
  /** last_seen_at at least this many days ago. */
  recencyMinDays: number | null;
  /** last_seen_at less than this many days ago. */
  recencyMaxDays: number | null;
  /** Keyset cursor: rows strictly older than (created_at, id). */
  before: { createdAt: string; id: string } | null;
}

/** One row of the People list (timestamps as returned by the driver for raw SQL). */
export type ContactListRow = {
  id: string;
  tenant_id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  lifecycle_state: string;
  engagement_depth: string | null;
  payment_status: string | null;
  last_seen_at: string | null;
  created_at: string;
};

export interface ApiContactsQueries {
  /** The tenant's settings JSON (null when unset or the tenant does not exist). */
  getTenantSettings(input: { tenantId: string }): Promise<unknown>;
  /** One page of the tenant's contacts, newest first (created_at DESC, id DESC). */
  listContacts(input: { tenantId: string; filter: ContactListFilter; limit: number }): Promise<ContactListRow[]>;
  /** One contact of the tenant (raw row), or null. */
  getContact(input: { tenantId: string; contactId: string }): Promise<Record<string, unknown> | null>;
  /** The contact's flow memberships with flow names, newest entry first. */
  listContactMemberships(input: { tenantId: string; contactId: string }): Promise<Record<string, unknown>[]>;
  /** The tenant's suppression for an email (case-insensitive), or null. */
  findSuppression(input: { tenantId: string; email: string }): Promise<Record<string, unknown> | null>;
  /** True when the contact exists in the tenant. */
  contactExists(input: { tenantId: string; contactId: string }): Promise<boolean>;
  /**
   * One page of the contact's merged timeline (events, transitions, messages),
   * ordered (occurred_at DESC, id DESC), strictly older than the cursor when given.
   */
  listContactTimeline(input: {
    tenantId: string;
    contactId: string;
    before: { occurredAt: string; id: string } | null;
    limit: number;
  }): Promise<Record<string, unknown>[]>;
}
