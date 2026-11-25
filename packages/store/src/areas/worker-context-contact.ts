/**
 * Queries used by packages/worker/src/context-contact.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-context-contact.ts (Postgres) and, later,
 * ../d1/worker-context-contact.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/**
 * Raw timestamp value: the Postgres implementation returns what the driver
 * gives for raw SQL (string, or Date with custom parsers). Callers normalise.
 */
export type WorkerContextContactTimestamp = Date | string | null;

/** The contact columns the context packet reads. */
export interface WorkerContextContactRow {
  name: string | null;
  email: string | null;
  company: string | null;
  properties: Record<string, unknown> | null;
  lifecycle_state: string;
  engagement_depth: string | null;
  payment_status: string | null;
  first_seen_at: WorkerContextContactTimestamp;
  last_seen_at: WorkerContextContactTimestamp;
}

/** Aggregate prior-contact history over a contact's lifecycle messages. */
export interface WorkerPriorContactRow {
  /** COUNT as string (bigint). */
  total_sent: string;
  messages_opened: string;
  messages_clicked: string;
  last_sent_at: WorkerContextContactTimestamp;
  last_action_type: string | null;
}

export interface WorkerContextContactQueries {
  /** The contact's identity and lifecycle columns, tenant-scoped; null when not found. */
  getContact(input: { tenantId: string; contactId: string }): Promise<WorkerContextContactRow | null>;
  /**
   * Prior-contact aggregates over the contact's lifecycle messages
   * (tenant-scoped): sent count, opened (opened or clicked), clicked,
   * latest sent_at and the action type of the latest sent message.
   */
  getPriorContactStats(input: { tenantId: string; contactId: string }): Promise<WorkerPriorContactRow>;
}
