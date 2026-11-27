/**
 * Queries used by packages/api/src/routes/contacts.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-contacts.ts (Postgres) and, later,
 * ../d1/api-contacts.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
import type { ContactAudience } from "@claros/core";
import type { ContactTopicStatusRow } from "./shared-topics.js";

/** Sort keys of the People list. */
export type ContactSortKey = "created" | "name" | "joined" | "last_seen";

/**
 * How the People list is ordered. Every key is non-null by construction, so
 * one keyset cursor (key, id) pages through any of them:
 * - created:   created_at (when the contact landed in this product).
 * - name:      lower(coalesce(nullif(trim(name), ''), email, external_id)),
 *              byte order (the same on Postgres and SQLite).
 * - joined:    coalesce(first_seen_at, created_at).
 * - last_seen: coalesce(last_seen_at, epoch), so never-seen contacts sort as
 *              the least recently seen.
 * The id breaks ties in the same direction.
 */
export interface ContactListSort {
  key: ContactSortKey;
  order: "asc" | "desc";
}

/** Filters for the People list. Null means "no filter". */
export interface ContactListFilter {
  lifecycleState: string | null;
  engagementDepth: string | null;
  paymentStatus: string | null;
  /** ILIKE pattern (with % wildcards) on email, name or external_id. */
  searchPattern: string | null;
  /**
   * Initial of the name sort key: "a".."z", or "#" for anything else
   * (digits, symbols, non-ASCII letters, empty).
   */
  letter: string | null;
  /** first_seen_at at least this many days ago. */
  tenureMinDays: number | null;
  /** first_seen_at less than this many days ago. */
  tenureMaxDays: number | null;
  /** last_seen_at at least this many days ago. */
  recencyMinDays: number | null;
  /** last_seen_at less than this many days ago. */
  recencyMaxDays: number | null;
  /** coalesce(first_seen_at, created_at) at or after this instant (ISO 8601). */
  joinedAfter: string | null;
  /** coalesce(first_seen_at, created_at) strictly before this instant (ISO 8601). */
  joinedBefore: string | null;
  /** last_seen_at at or after this instant (ISO 8601); never-seen contacts never match. */
  lastSeenAfter: string | null;
  /** last_seen_at strictly before this instant (ISO 8601); never-seen contacts never match. */
  lastSeenBefore: string | null;
  /**
   * Paid / free split on current payment_status (../shared/audience.ts).
   * Optional; absent or "all" means no filter.
   */
  audience?: ContactAudience;
}

/**
 * Keyset cursor: rows strictly after (key, id) in the list order. `key` is
 * the row's `sort_key` as the same backend returned it; a timestamp key may
 * also be an ISO 8601 string (cursors issued before sorting existed).
 */
export interface ContactListCursor {
  key: string | number;
  id: string;
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
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  /** The row's value of the sort key, for the next cursor. Opaque to callers. */
  sort_key: string | number;
};

/** How many contacts start with one initial (lowercased first character of the name sort key). */
export type ContactInitialCount = { initial: string; n: number };

/** A note a team member wrote about a contact, with the author when the user row exists. */
export type ContactNoteRow = {
  id: string;
  body: string;
  createdAt: Date;
  authorUserId: string | null;
  authorName: string | null;
  authorEmail: string | null;
};

export interface ApiContactsQueries {
  /** The tenant's settings JSON (null when unset or the tenant does not exist). */
  getTenantSettings(input: { tenantId: string }): Promise<unknown>;
  /** One page of the tenant's contacts in the sort order, after the cursor when given. */
  listContacts(input: {
    tenantId: string;
    filter: ContactListFilter;
    sort: ContactListSort;
    after: ContactListCursor | null;
    limit: number;
  }): Promise<ContactListRow[]>;
  /**
   * Matching contacts counted per initial (see ContactListFilter.letter),
   * with every filter applied except `letter`. The sum is the total without
   * the letter filter; the rows also tell which letters have anyone.
   */
  countContactsByInitial(input: { tenantId: string; filter: ContactListFilter }): Promise<ContactInitialCount[]>;
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
  /** A contact of the tenant by exact email (case ignored), or null. */
  findContactByEmail(input: { tenantId: string; email: string }): Promise<{ id: string; externalId: string; email: string | null } | null>;
  /**
   * Erase a contact of the tenant (G12): its events, transitions, conflicts,
   * topic statuses, notes, memberships, messages and their message events, pending
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
  /**
   * Set the contact's name from the dashboard and lock it (name_locked_at = now),
   * so identify no longer changes it. With lock false the name is left as it is
   * and the lock cleared: the next identify that sends a name sets it again.
   * False when the contact does not exist.
   */
  setContactName(input: { tenantId: string; contactId: string; name: string; lock: true; now: Date } | { tenantId: string; contactId: string; lock: false }): Promise<boolean>;
  /** The contact's notes, newest first. */
  listContactNotes(input: { tenantId: string; contactId: string }): Promise<ContactNoteRow[]>;
  /** Add a note to a contact of the tenant. Null when the contact does not exist. */
  addContactNote(input: { tenantId: string; contactId: string; authorUserId: string | null; body: string; now: Date }): Promise<ContactNoteRow | null>;
  /** Delete one note of the contact. False when there is no such note. */
  deleteContactNote(input: { tenantId: string; contactId: string; noteId: string }): Promise<boolean>;
}
