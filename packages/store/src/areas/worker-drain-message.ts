/**
 * Queries used by packages/worker/src/drain-message.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-drain-message.ts (Postgres) and, later,
 * ../d1/worker-drain-message.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A lifecycle message claimed for sending (raw column names). */
export interface WorkerDrainMessageClaimed {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_step_order: number | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  retry_count: number | null;
  /** Topic of the message, or null. */
  topic_id: string | null;
}

export interface WorkerDrainMessageQueries {
  /**
   * CAS approved -> sending for one message that is due (scheduled_send_at null or <= now).
   * Returns the claimed row, or null when another caller already claimed it or it is not due;
   * exactly one concurrent caller gets the row.
   */
  claimApprovedMessage(tenantId: string, messageId: string, now: Date): Promise<WorkerDrainMessageClaimed | null>;
}
