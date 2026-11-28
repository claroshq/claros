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
  /** P5 additions. */
  context_snapshot?: unknown;
  choose_decision?: unknown;
  opening_line?: string | null;
  kb_entry_id?: string | null;
  imported?: boolean | null;
  /** Revise: the pending instruction and the thread (null on rows without one). */
  revision_request?: string | null;
  revisions?: unknown;
  /** Set by getMessage only. */
  approved_at?: string | Date | null;
};

/** One reviewer instruction of a revise thread (lifecycle_messages.revisions). */
export interface MessageRevision {
  instruction: string;
  /** "user:<id>" or "api_key:<id>". */
  by: string;
  /** ISO 8601. */
  at: string;
}

/**
 * One group of open (not yet final) messages, for queue counts (MCP
 * queue_summary and list_flows): per flow and status. `reason` is
 * 'llm_budget' for pending_generation rows waiting for the daily LLM
 * budget, 'generation_failed' for failed rows whose generation failed,
 * else null.
 */
export type OpenMessageCount = {
  flow_id: string;
  flow_class: string | null;
  status: string;
  reason: string | null;
  n: number;
  oldest_created_at: Date | null;
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
   * With revision (revise), revision_request is set to the reviewer's
   * instruction and the entry is appended to revisions; the current draft
   * stays on the row for the worker to revise. Without it, revision_request
   * is cleared.
   */
  regenerateMessage(input: {
    tenantId: string;
    messageId: string;
    actionType: string | null;
    revision?: MessageRevision;
    now: Date;
  }): Promise<boolean>;
  /** CAS approved -> cancelled (G20); status_reason 'cancelled', rejected_by = actor. */
  cancelMessage(input: { tenantId: string; messageId: string; actor: string; now: Date }): Promise<boolean>;
  /**
   * CAS approved -> pending_approval (G20): approved_at and approved_by
   * cleared; writes the batched message.pending_approval outbox entry.
   */
  unapproveMessage(input: { tenantId: string; messageId: string; now: Date; outbox: OutboxEntry[] }): Promise<boolean>;
  /**
   * CAS value_gated -> pending_approval: a person reviews a draft the value
   * gate held. The draft is kept; status_reason becomes 'value_gate: <the
   * gate's reason>' so the review shows the objection. Writes the batched
   * message.pending_approval outbox entry.
   */
  releaseValueGated(input: { tenantId: string; messageId: string; now: Date; outbox: OutboxEntry[] }): Promise<boolean>;
  /** CAS value_gated -> cancelled; status_reason 'dismissed', rejected_by = actor. */
  dismissValueGated(input: { tenantId: string; messageId: string; actor: string; now: Date }): Promise<boolean>;
  /** CAS failed (generation_failed) -> pending_generation with retry_count reset; true when this call made the transition. */
  requeueFailedGeneration(input: { tenantId: string; messageId: string; now: Date }): Promise<boolean>;
  /** Status and content of a tenant's message, or null when it does not exist. */
  getMessageContent(input: { tenantId: string; messageId: string }): Promise<{
    status: string;
    subject: string | null;
    bodyHtml: string | null;
    bodyText: string | null;
  } | null>;
  /** One message of the tenant in the list row shape (plus approved_at), or null. */
  getMessage(input: { tenantId: string; messageId: string }): Promise<MessageListRow | null>;
  /**
   * Counts of the tenant's open messages grouped by flow, status and reason:
   * pending_approval, approved (not sent yet) and pending_generation at any
   * age; value_gated and generation-failed messages created at or after
   * `since`.
   */
  countOpenMessages(input: { tenantId: string; since: Date }): Promise<OpenMessageCount[]>;
  /** Current status of a tenant's message, or null when it does not exist. */
  getMessageStatus(input: { tenantId: string; messageId: string }): Promise<string | null>;
}
