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
import type { OutboxEntry } from "./shared-outbox.js";

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
  /** G20 additions (null on rows the columns did not exist for). */
  flow_name?: string | null;
  flow_class?: string | null;
  status_reason?: string | null;
  approved_by?: string | null;
  rejected_by?: string | null;
  edited_by?: string | null;
  edited_at?: string | Date | null;
  original_subject?: string | null;
  original_body_html?: string | null;
  original_body_text?: string | null;
  forced_action_type?: string | null;
};

/** Actor of an approval action: "user:<id>" or "api_key:<id>" (G20). */
export type ApprovalActor = string | null | undefined;

export interface ApiMessagesQueries {
  /**
   * One page of the tenant's messages in a status: critical-class flows
   * first (G20), then oldest first (created_at, id), strictly after the
   * cursor when given (rank 0 = critical, 1 = other; a cursor without a
   * rank counts as 1).
   */
  listMessages(input: {
    tenantId: string;
    status: string;
    after: { createdAt: string; id: string; rank?: number } | null;
    limit: number;
  }): Promise<MessageListRow[]>;
  /**
   * CAS pending_approval -> approved for many ids; returns the ids that
   * transitioned. Records approved_by and writes message.approved outbox
   * entries for the transitioned ids, atomically.
   */
  approveMessages(input: { tenantId: string; ids: string[]; now: Date; actor?: ApprovalActor }): Promise<string[]>;
  /** CAS pending_approval -> rejected for many ids (rejected_by, message.rejected); returns the ids that transitioned. */
  rejectMessages(input: { tenantId: string; ids: string[]; now: Date; actor?: ApprovalActor }): Promise<string[]>;
  /** CAS pending_approval -> approved for one message; true when this call made the transition. */
  approveMessage(input: { tenantId: string; messageId: string; now: Date; actor?: ApprovalActor }): Promise<boolean>;
  /** CAS pending_approval -> rejected for one message; true when this call made the transition. */
  rejectMessage(input: { tenantId: string; messageId: string; now: Date; actor?: ApprovalActor }): Promise<boolean>;
  /**
   * Edit subject and body of a pending_approval message (G20, CAS). The
   * content as drafted is kept in original_* on the first edit; edited_by
   * and edited_at are set. True when this call made the change.
   */
  editMessage(input: {
    tenantId: string;
    messageId: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
    actor: string;
    now: Date;
  }): Promise<boolean>;
  /**
   * CAS pending_approval -> pending_generation for a new draft (G20). With
   * actionType, brain_action_type and forced_action_type are set and the
   * content worker skips decide. Edit markers are cleared; retry_count 0.
   */
  regenerateMessage(input: { tenantId: string; messageId: string; actionType: string | null; now: Date }): Promise<boolean>;
  /** CAS approved -> cancelled (G20); status_reason 'cancelled', rejected_by = actor. */
  cancelMessage(input: { tenantId: string; messageId: string; actor: string; now: Date }): Promise<boolean>;
  /**
   * CAS approved -> pending_approval (G20): approved_at and approved_by
   * cleared; writes the batched message.pending_approval outbox entry.
   */
  unapproveMessage(input: { tenantId: string; messageId: string; now: Date; outbox: OutboxEntry[] }): Promise<boolean>;
  /** CAS failed (generation_failed) -> pending_generation with retry_count reset; true when this call made the transition. */
  requeueFailedGeneration(input: { tenantId: string; messageId: string; now: Date }): Promise<boolean>;
  /** Status and content of a tenant's message, or null when it does not exist. */
  getMessageContent(input: { tenantId: string; messageId: string }): Promise<{
    status: string;
    subject: string | null;
    bodyHtml: string | null;
    bodyText: string | null;
  } | null>;
  /** Current status of a tenant's message, or null when it does not exist. */
  getMessageStatus(input: { tenantId: string; messageId: string }): Promise<string | null>;
}
