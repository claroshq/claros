/**
 * Context packet builder - slice 18.1: contact, lifecycle, tenure,
 * and prior-contact sections.
 *
 * Populates the four sections of the context packet that come from the
 * `contacts` and `lifecycle_messages` tables. Every other section (cadence,
 * behavior, flow step metadata, KB context) is left to later slices.
 *
 * Design constraints (from §3.5 [impl] notes and CLAUDE.md):
 *   - No I/O in brain-oss; this module lives in packages/worker.
 *   - Absent data stays absent: nullable columns are not coerced to empty
 *     strings or zeros. Optional fields are omitted from returned objects
 *     when the underlying value is null/undefined.
 *   - plan is read from contacts.properties['plan'] per impl note (7).
 *     Absent means undefined (omitted from packet).
 *   - Tenure thresholds use 30-day month approximation:
 *       new          < 30 days
 *       growing     30 - 89 days  (1 month to < 3 months)
 *       established  90 - 179 days (3 months to < 6 months)
 *       loyal       >= 180 days   (6 months+)
 *     The spec defines boundaries in months without specifying exact day
 *     counts. 30-day approximation is a deliberate implementation choice;
 *     see the ambiguity note in the task 18 report.
 *   - All queries are scoped by tenant_id. No cross-tenant data leaks.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { publicLifecycleState } from "@claros/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Contact identity section of the context packet. */
export interface ContactSection {
  name?: string;
  email?: string;
  company?: string;
  /** Read from contacts.properties['plan']. Absent if property is not set. */
  plan?: string;
  /** ISO-8601 date string derived from contacts.first_seen_at. */
  signupDate?: string;
  /** ISO-8601 date string derived from contacts.last_seen_at. */
  lastSeen?: string;
}

/** Lifecycle state section of the context packet. */
export interface LifecycleSection {
  /** The contact's lifecycle state by its public name (e.g. "engaged", "gone_quiet"). */
  state: string;
  /** Tenure in days, computed from first_seen_at to now. Absent if first_seen_at is null. */
  tenureDays?: number;
  /** The contact's engagement_depth (e.g. "regular"). Absent if null. */
  engagementDepth?: string;
  /** The contact's payment_status (e.g. "paid"). Absent if null. */
  paymentStatus?: string;
}

/**
 * Tenure classification section of the context packet.
 *
 * Thresholds (30-day month approximation):
 *   new          < 30 days
 *   growing     30 - 89 days
 *   established  90 - 179 days
 *   loyal       >= 180 days
 *
 * Absent if contacts.first_seen_at is null (cannot compute tenure).
 */
export interface TenureSection {
  /** One of: "new" | "growing" | "established" | "loyal" */
  category: string;
  /** Tenure in days (same value as lifecycle.tenureDays). */
  days: number;
}

/** Prior contact history section of the context packet. */
export interface PriorContactSection {
  /** ISO-8601 date string of the most recent sent_at. Absent if no sent messages. */
  lastMessageDate?: string;
  /** brain_action_type of the most recent sent message. Absent if no sent messages. */
  lastMessageType?: string;
  /** Total messages in 'sent' status for this contact (scoped to tenant). */
  totalMessagesSent: number;
  /**
   * Messages with feedback = 'opened' OR feedback = 'clicked'.
   *
   * feedback is a single advancing column. A message that was opened and then
   * clicked is stored as feedback = 'clicked' (the open value is overwritten).
   * Counting only feedback = 'opened' would exclude every message that was
   * opened and then clicked - undercounting engagement for the most engaged
   * contacts. Correct count: opened + clicked (clicked implies at least
   * implicit open engagement).
   *
   * bounced and complained are NOT counted: bounced = undelivered (never read),
   * complained = spam report (not an engagement signal).
   */
  messagesOpened: number;
  /** Messages with feedback = 'clicked'. */
  messagesClicked: number;
}

/** The result of buildContactSections for a single contact. */
export interface ContactSectionsResult {
  contact: ContactSection;
  lifecycle: LifecycleSection;
  /** Absent when contacts.first_seen_at is null. */
  tenure?: TenureSection;
  priorContact: PriorContactSection;
  /**
   * True when totalMessagesSent === 0 (no prior outreach to this contact).
   * Matches the spec's top-level "first_contact" boolean.
   */
  firstContact: boolean;
}

// ---------------------------------------------------------------------------
// Tenure thresholds
// ---------------------------------------------------------------------------

/**
 * Tenure category thresholds in days (30-day month approximation).
 *
 * The spec defines boundaries as "1mo", "3mo", "6mo". Day counts are
 * implementation choices. Reported as ambiguous in the task 18 report.
 */
export const TENURE_THRESHOLDS = {
  GROWING_DAYS: 30, // >= 30 days -> out of "new"
  ESTABLISHED_DAYS: 90, // >= 90 days -> out of "growing"
  LOYAL_DAYS: 180, // >= 180 days -> out of "established"
} as const;

/**
 * Derive a tenure category from a day count.
 *
 * @param days - Tenure in whole days (>= 0).
 * @returns One of: "new" | "growing" | "established" | "loyal"
 */
export function tenureCategory(days: number): string {
  if (days < TENURE_THRESHOLDS.GROWING_DAYS) return "new";
  if (days < TENURE_THRESHOLDS.ESTABLISHED_DAYS) return "growing";
  if (days < TENURE_THRESHOLDS.LOYAL_DAYS) return "established";
  return "loyal";
}

// ---------------------------------------------------------------------------
// Query rows (raw DB shapes)
// ---------------------------------------------------------------------------

/**
 * Timestamp columns from db.execute() raw SQL arrive as strings when the pg
 * driver has not been configured with custom type parsers. Accept both to be
 * safe. Use toDate() below to normalise to Date.
 */
type PgTimestamp = Date | string | null;

type ContactRow = {
  name: string | null;
  email: string | null;
  company: string | null;
  properties: Record<string, unknown> | null;
  lifecycle_state: string;
  engagement_depth: string | null;
  payment_status: string | null;
  first_seen_at: PgTimestamp;
  last_seen_at: PgTimestamp;
};

type PriorContactRow = {
  total_sent: string; // pg COUNT returns bigint as string
  messages_opened: string;
  messages_clicked: string;
  last_sent_at: PgTimestamp;
  last_action_type: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw pg timestamp value to a Date, or null if absent.
 * db.execute() returns timestamp columns as strings; Drizzle ORM's select()
 * returns them as Date objects. Both are handled here.
 */
function toDate(v: PgTimestamp): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Fetch the contact, lifecycle, tenure, and prior-contact sections of the
 * context packet for a single contact.
 *
 * Issues two queries:
 *   1. SELECT from contacts (contact identity + lifecycle state).
 *   2. Aggregate over lifecycle_messages (prior contact history).
 *
 * Both queries are scoped by tenantId to prevent cross-tenant data leaks.
 *
 * @param db        - Drizzle database instance (node-postgres).
 * @param tenantId  - The tenant that owns this contact.
 * @param contactId - The contact UUID.
 * @param now       - Current time (injected for testability).
 * @returns The four populated sections, or null if the contact is not found.
 */
export async function buildContactSections(
  db: Db,
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<ContactSectionsResult | null> {
  // Query 1: contact row
  const row: ContactRow | null = await storeFor(db).workerContextContact.getContact({
    tenantId,
    contactId,
  });

  if (row === null) return null;

  // Query 2: prior contact history (opened counts opened + clicked; see
  // PriorContactSection.messagesOpened and the Store method)
  const prior: PriorContactRow = await storeFor(db).workerContextContact.getPriorContactStats({
    tenantId,
    contactId,
  });

  // ---------------------------------------------------------------------------
  // Contact section
  // ---------------------------------------------------------------------------
  const contact: ContactSection = {};
  if (row.name != null) contact.name = row.name;
  if (row.email != null) contact.email = row.email;
  if (row.company != null) contact.company = row.company;

  // plan comes from properties['plan']; absent if missing or not a string
  if (row.properties != null) {
    const plan = row.properties["plan"];
    if (typeof plan === "string") contact.plan = plan;
  }

  const firstSeenAt = toDate(row.first_seen_at);
  const lastSeenAt = toDate(row.last_seen_at);

  if (firstSeenAt != null) {
    contact.signupDate = firstSeenAt.toISOString();
  }
  if (lastSeenAt != null) {
    contact.lastSeen = lastSeenAt.toISOString();
  }

  // ---------------------------------------------------------------------------
  // Tenure days (used in both lifecycle and tenure sections)
  // ---------------------------------------------------------------------------
  let tenureDays: number | undefined;
  if (firstSeenAt != null) {
    const msElapsed = now.getTime() - firstSeenAt.getTime();
    // Floor to whole days; negative clamped to 0 (clock skew / future first_seen_at)
    tenureDays = Math.max(0, Math.floor(msElapsed / (1000 * 60 * 60 * 24)));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle section
  // ---------------------------------------------------------------------------
  const lifecycle: LifecycleSection = { state: publicLifecycleState(row.lifecycle_state) };
  if (tenureDays !== undefined) lifecycle.tenureDays = tenureDays;
  if (row.engagement_depth != null) lifecycle.engagementDepth = row.engagement_depth;
  if (row.payment_status != null) lifecycle.paymentStatus = row.payment_status;

  // ---------------------------------------------------------------------------
  // Tenure section
  // ---------------------------------------------------------------------------
  let tenure: TenureSection | undefined;
  if (tenureDays !== undefined) {
    tenure = {
      category: tenureCategory(tenureDays),
      days: tenureDays,
    };
  }

  // ---------------------------------------------------------------------------
  // Prior contact section
  // ---------------------------------------------------------------------------
  // pg COUNT() returns bigint as string; parse to number.
  const totalSent = parseInt(prior.total_sent, 10) || 0;
  const opened = parseInt(prior.messages_opened, 10) || 0;
  const clicked = parseInt(prior.messages_clicked, 10) || 0;

  const priorContact: PriorContactSection = {
    totalMessagesSent: totalSent,
    messagesOpened: opened,
    messagesClicked: clicked,
  };
  const lastSentAt = toDate(prior.last_sent_at);
  if (lastSentAt != null) {
    priorContact.lastMessageDate = lastSentAt.toISOString();
  }
  if (prior.last_action_type != null) {
    priorContact.lastMessageType = prior.last_action_type;
  }

  return {
    contact,
    lifecycle,
    tenure,
    priorContact,
    firstContact: totalSent === 0,
  };
}
