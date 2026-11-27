/**
 * Queries used by packages/api/src/routes/sent-log.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-sent-log.ts (Postgres) and, later,
 * ../d1/api-sent-log.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Filters for the sent-mail log list. Every value is already validated by the caller. */
export interface SentLogFilter {
  /** One status, or null for all sent-log statuses (sending, sent, failed, suppressed). */
  status: string | null;
  /** Flow id (a valid uuid), or null. */
  flowId: string | null;
  /** Substring to match (case-insensitive) on recipient address, contact email or contact name, or null. */
  recipient: string | null;
  /** ISO timestamp: sent_at >= from, or null. */
  from: string | null;
  /** ISO timestamp: sent_at <= to, or null. */
  to: string | null;
  /** opened (opened or clicked), clicked, bounced, complained, or null. */
  feedback: string | null;
  /** Keyset cursor: rows strictly older than (sent_at truncated to ms, id), or null. */
  before: { sentAt: string; id: string } | null;
}

/** One row of the sent-mail log (timestamps as returned by the driver for raw SQL). */
export type SentLogRow = {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_name: string | null;
  status: string;
  feedback: string | null;
  subject: string | null;
  recipient_address: string | null;
  sent_at: string | null;
  created_at: string | null;
  contact_email: string | null;
  contact_name: string | null;
  contact_external_id: string | null;
};

/** A sent-log message with content and envelope. */
export type SentLogDetailRow = {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_name: string | null;
  membership_id: string;
  flow_step_order: number | null;
  status: string;
  feedback: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  brain_reasoning: string | null;
  brain_action_type: string | null;
  scheduled_send_at: string | null;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  retry_count: number;
  provider_message_id: string | null;
  recipient_address: string | null;
  contact_email: string | null;
  contact_name: string | null;
  contact_external_id: string | null;
  /** The flow's compiled plan (parsed JSON), or null. */
  flow_compiled_plan: unknown;
};

/** One event in a message's timeline. */
export type SentLogEventRow = {
  id: string;
  event_type: string;
  occurred_at: string;
  metadata: unknown;
  created_at: string;
};

export interface ApiSentLogQueries {
  /** One page of the tenant's sent-mail log, newest sent_at first (NULLS LAST, then id DESC). */
  listSentMessages(input: {
    tenantId: string;
    filter: SentLogFilter;
    limit: number;
    /** Rows to skip (numbered pages); 0 or omitted for none. */
    offset?: number;
  }): Promise<SentLogRow[]>;
  /** How many rows listSentMessages would return for the filter without a limit (the cursor is ignored). */
  countSentMessages(input: { tenantId: string; filter: SentLogFilter }): Promise<number>;
  /** One message of the tenant with contact and flow names, or null. */
  getSentMessage(input: { tenantId: string; messageId: string }): Promise<SentLogDetailRow | null>;
  /** The message's events in chronological order (at most 100). */
  listMessageEvents(input: { tenantId: string; messageId: string }): Promise<SentLogEventRow[]>;
}
