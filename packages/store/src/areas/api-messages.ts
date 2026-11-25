/**
 * Queries used by packages/api/src/routes/messages.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-messages.ts (Postgres) and, later,
 * ../d1/api-messages.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 *
 * State transitions here are compare-and-swap updates (WHERE status =
 * expected): concurrent callers cannot both move the same message.
 */

/** Row shape of the message list query (joined with contacts). */
export type MessageListRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_step_order: number | null;
  status: string;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  brain_reasoning: string | null;
  brain_action_type: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  contact_email: string | null;
  contact_name: string | null;
  contact_external_id: string | null;
  scheduled_send_at: string | Date | null;
};

export interface ApiMessagesQueries {
  /** One page of the tenant's messages in a status, oldest first (created_at, id), strictly after the cursor when given. */
  listMessages(input: {
    tenantId: string;
    status: string;
    after: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<MessageListRow[]>;
  /** CAS pending_approval -> approved for many ids in one UPDATE; returns the ids that transitioned. */
  approveMessages(input: { tenantId: string; ids: string[]; now: Date }): Promise<string[]>;
  /** CAS pending_approval -> rejected for many ids in one UPDATE; returns the ids that transitioned. */
  rejectMessages(input: { tenantId: string; ids: string[]; now: Date }): Promise<string[]>;
  /** CAS pending_approval -> approved for one message; true when this call made the transition. */
  approveMessage(input: { tenantId: string; messageId: string; now: Date }): Promise<boolean>;
  /** CAS pending_approval -> rejected for one message; true when this call made the transition. */
  rejectMessage(input: { tenantId: string; messageId: string; now: Date }): Promise<boolean>;
  /** CAS failed (generation_failed) -> pending_generation with retry_count reset; true when this call made the transition. */
  requeueFailedGeneration(input: { tenantId: string; messageId: string; now: Date }): Promise<boolean>;
  /** Current status of a tenant's message, or null when it does not exist. */
  getMessageStatus(input: { tenantId: string; messageId: string }): Promise<string | null>;
}
