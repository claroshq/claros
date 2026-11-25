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

export interface WorkerContentQueries {
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
