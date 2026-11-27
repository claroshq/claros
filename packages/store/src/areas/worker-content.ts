/**
 * Queries used by packages/worker/src/content.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-content.ts (Postgres) and, later,
 * ../d1/worker-content.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A message claimed for content generation (status already 'generating'). */
import type { OutboxEntry } from "./shared-outbox.js";
import type { ContactConditionQueries } from "./shared-conditions.js";

export interface WorkerContentClaimedMessage {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  membershipId: string;
  flowStepOrder: number | null;
  brainActionType: string | null;
  /** Set by a regenerate request that forced the action type (G20): decide is skipped. */
  forcedActionType?: string | null;
  /** Revise: the reviewer's instruction; the draft below is to be revised, not replaced. */
  revisionRequest?: string | null;
  /** The draft on the row when it was claimed (the one under revision). */
  previousSubject?: string | null;
  previousBodyText?: string | null;
}

/** Rendered content written to a message. */
export interface WorkerContentBody {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/** An active template's raw content. */
export interface WorkerContentTemplate {
  subject: string;
  body_html: string;
  body_text: string | null;
}

/** Contact fields available to template rendering. */
export interface WorkerContentTemplateContact {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  external_id: string;
  properties: Record<string, unknown> | null;
}

/** Product and flow facts used at render time (G11, G19, G22). */
export interface WorkerContentRenderInfo {
  tenantSlug: string;
  tenantName: string;
  settings: Record<string, unknown>;
  locale: string | null;
  flowSlug: string | null;
  flowName: string;
  flowClass: string;
}

/** Fields written to a message next to its content; undefined keeps the stored value. */
export interface WorkerContentMessageMeta {
  contextSnapshot?: unknown;
  chooseDecision?: unknown;
  openingLine?: string | null;
  kbEntryId?: string | null;
  /** The action type the message was drafted for (a choose step's pick). */
  actionType?: string | null;
}

/** A knowledge base entry offered to kb_select or pinned context (G18). */
export interface WorkerContentKbEntry {
  id: string;
  title: string;
  content: string;
  tags: string[] | null;
  createdAt: Date | null;
}

/** Message statuses after which a KB entry does not count as used (never sent, never will be). */
export const KB_UNUSED_STATUSES = ["failed", "rejected", "cancelled", "skipped", "value_gated", "suppressed"] as const;

export interface WorkerContentQueries extends ContactConditionQueries {
  /**
   * The topic gate of a flow's topic for a contact (kind, default, the
   * contact's explicit status), or null when the flow has no topic.
   */
  getFlowTopicGate(input: { tenantId: string; contactId: string; flowId: string }): Promise<{ kind: string; defaultSubscribed: boolean; status: string | null } | null>;
  /**
   * Active entries of a category, oldest first (created_at, id). With
   * excludeUsedBy, entries used by another message of that contact (any
   * status but KB_UNUSED_STATUSES, imported history included) are left out.
   */
  listKbCandidates(input: {
    tenantId: string;
    category: string;
    excludeUsedBy?: { contactId: string; exceptMessageId: string } | null;
  }): Promise<WorkerContentKbEntry[]>;
  /** Active pinned entries, oldest first. */
  listPinnedKb(tenantId: string): Promise<WorkerContentKbEntry[]>;
  /**
   * Fail a drafted message that a post-draft check blocked (G19: status_reason
   * 'link_not_allowed' or 'text_rule_forbidden'), keeping the draft for
   * review. CAS from `fromStatus`.
   */
  markBlocked(input: {
    messageId: string;
    fromStatus: "generating" | "awaiting_content";
    statusReason: string;
    reasoning: string;
    body: WorkerContentBody;
    now: Date;
  }): Promise<boolean>;
  /** Product (slug, name, settings, locale) and flow (slug, name) of a message; null when either is missing. */
  getRenderInfo(input: { tenantId: string; flowId: string }): Promise<WorkerContentRenderInfo | null>;
  /** Write render metadata (context snapshot, choose decision, opening line, KB entry, action type) to a message. */
  saveMessageMeta(input: {
    tenantId: string;
    messageId: string;
    meta: WorkerContentMessageMeta;
    /** Outbox entries (G30 choose.decided) written in the same atomic unit. */
    events?: { tenantId: string; outbox: OutboxEntry[] };
  }): Promise<void>;
  /**
   * Atomically claim up to `limit` pending_generation messages of the given tenants
   * (pending_generation -> generating), oldest first. Each row is returned to exactly one
   * concurrent caller; rows locked by another caller are skipped, never waited on.
   */
  claimContentBatch(input: { now: Date; limit: number; tenantIds: string[] }): Promise<WorkerContentClaimedMessage[]>;
  /** Distinct tenants that have pending_generation messages. */
  listTenantsWithPendingGeneration(): Promise<string[]>;
  /** CAS fromStatus -> failed with brain_reasoning; true when this call won. */
  markFailed(
    messageId: string,
    fromStatus: "generating" | "awaiting_content",
    reasoning: string,
    now: Date,
    /** Outbox entries (G5) written with the transition, when it happens. */
    events?: { tenantId: string; outbox: OutboxEntry[] },
  ): Promise<boolean>;
  /** CAS generating -> skipped with brain_reasoning; true when this call won. */
  markSkipped(messageId: string, reasoning: string, now: Date): Promise<boolean>;
  /** P5b: generating -> pending_generation with status_reason 'llm_budget' (CAS); the daily LLM budget is spent. */
  releaseForBudget(messageId: string, now: Date): Promise<boolean>;
  /** P5b: properties of the event that enrolled the membership ({{event.*}}), or null. */
  getMembershipTriggerProperties(input: { tenantId: string; membershipId: string }): Promise<Record<string, unknown> | null>;
  /** CAS generating -> awaiting_content with brain_reasoning; true when this call won. */
  markAwaitingContent(messageId: string, reasoning: string | null, now: Date): Promise<boolean>;
  /** CAS awaiting_content -> value_gated, storing the draft and reasoning; true when this call won. */
  markValueGated(messageId: string, body: WorkerContentBody, reasoning: string, now: Date): Promise<boolean>;
  /**
   * CAS awaiting_content -> status (pending_approval or approved) with the drafted content;
   * true when this call won.
   */
  completeDraft(
    messageId: string,
    status: "approved" | "pending_approval",
    body: WorkerContentBody,
    approvedAt: Date | null,
    now: Date,
    /** Outbox entries (G5) written with the transition, when it happens. */
    events?: { tenantId: string; outbox: OutboxEntry[] },
  ): Promise<boolean>;
  /**
   * CAS generating -> status (pending_approval or approved) with rendered template content and
   * brain_reasoning; true when this call won.
   */
  completeTemplate(
    messageId: string,
    status: "approved" | "pending_approval",
    body: WorkerContentBody,
    approvedAt: Date | null,
    reasoning: string,
    now: Date,
    /** Outbox entries (G5) written with the transition, when it happens. */
    events?: { tenantId: string; outbox: OutboxEntry[] },
  ): Promise<boolean>;
  /** The flow's approval_mode, or null when unset or the flow does not exist. */
  getFlowApprovalMode(flowId: string): Promise<string | null>;
  /** The tenant's active template by slug, or null. */
  getActiveTemplate(tenantId: string, slug: string): Promise<WorkerContentTemplate | null>;
  /** The tenant's contact fields for template rendering, or null when not found. */
  getTemplateContact(tenantId: string, contactId: string): Promise<WorkerContentTemplateContact | null>;
  /** The tenant's name, or null when the tenant does not exist. */
  getTenantName(tenantId: string): Promise<string | null>;
  /** The flow's name, or null when the flow does not exist. */
  getFlowName(flowId: string): Promise<string | null>;
}
