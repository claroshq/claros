/**
 * Queries used by packages/api/src/routes/contacts.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-contacts.ts (Postgres) and, later,
 * ../d1/api-contacts.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
import type { ContactTopicStatusRow } from "./shared-topics.js";

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
  /** Every topic of the tenant with the contact's explicit status for it (null = the topic default). */
  listContactTopics(input: { tenantId: string; contactId: string }): Promise<ContactTopicStatusRow[]>;
  /** A contact of the tenant by external_id, else by id (uuid), or null. */
  findContactByRef(input: { tenantId: string; ref: string }): Promise<{ id: string; externalId: string; email: string | null } | null>;
  /**
   * Erase a contact of the tenant (G12): its events, transitions, conflicts,
   * topic statuses, memberships, messages and their message events, pending
   * outbox rows about it, and the contact row, in one atomic unit.
   * Suppressions stay (they keep the address from being mailed again).
   * Returns false when the contact does not exist.
   */
  eraseContact(input: { tenantId: string; contactId: string }): Promise<boolean>;
  /**
   * Exclude a contact from lifecycle mail (G20): a manual suppression of its
   * email (when it has one and is not suppressed yet) and every message not
   * sent yet (pending_generation, generating, awaiting_content,
   * pending_approval, approved) moved to cancelled, in one atomic unit.
   * Cancelled messages get status_reason "excluded". Messages in sending are
   * left to the drain. Writes contact.suppressed
   * when a suppression was added. Returns what changed.
   */
  excludeContact(input: { tenantId: string; contactId: string; email: string | null; now: Date }): Promise<{ suppressed: boolean; cancelled: string[] }>;
}
