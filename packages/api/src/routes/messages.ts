/**
 * Message approval routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET   /v1/messages           list messages pending approval (cursor-paginated)
 *   POST  /v1/messages/:id/approve   advance pending_approval -> approved
 *   POST  /v1/messages/:id/reject    advance pending_approval -> rejected (terminal)
 *   POST  /v1/messages/:id/retry     re-queue a generation-failed message (failed -> pending_generation)
 *   POST  /v1/messages/bulk/approve  approve many pending_approval messages at once
 *   POST  /v1/messages/bulk/reject   reject many pending_approval messages at once
 *   PATCH /v1/messages/:id           edit subject/body while pending_approval (G20)
 *   GET   /v1/messages/:id           one message, any status (with its revise thread)
 *   POST  /v1/messages/:id/regenerate  new draft, optionally forcing the action type (G20)
 *                                      or revising the draft with a reviewer instruction
 *   POST  /v1/messages/:id/cancel      approved -> cancelled (G20)
 *   POST  /v1/messages/:id/unapprove   approved -> pending_approval (G20)
 *
 * Every route also accepts a product admin key with the `messages` scope
 * (G1). Approve/reject/edit/cancel record who acted ("user:<id>" or
 * "api_key:<id>"). Stale actions (the message moved on) answer 409 and
 * change nothing. The list puts critical-class flows first.
 *
 * CAS conventions: approve and reject use WHERE status = 'pending_approval'
 * to guarantee atomic state transitions. Approving an already-approved message
 * returns 200 (idempotent no-op). Rejecting a non-pending_approval message
 * returns 409 (terminal means no going back).
 *
 * Tenant isolation: messages belonging to another tenant return 404.
 */
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";
import {
  ACTION_TYPE_RE,
  BULK_MAX_IDS,
  approveMessage,
  approveMessages,
  cancelMessage,
  editInputError,
  editMessage,
  isUuid,
  listMessagesPage,
  parseBulkIds,
  REVISION_MAX_CHARS,
  regenerateMessage,
  rejectMessage,
  rejectMessages,
  unapproveMessage,
  type MessageActionResult,
  type ServiceContext,
} from "../services/messages.js";
import { renderMessagePreviews } from "../message-preview.js";
import type { AppContext } from "../http/env.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for GET /v1/messages list. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for GET /v1/messages list. */
const MAX_PAGE_SIZE = 200;

/** Row shape of the message list query (joined with contacts). */
type MessageListRow = Record<string, unknown> & {
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
  revision_request?: string | null;
  revisions?: unknown;
};

function serializeMessageRow(r: MessageListRow, previewHtml: string | null = null) {
  let waiting_reason: string | null = null;
  if (r.status === "approved" && r.scheduled_send_at) {
    const scheduled = r.scheduled_send_at instanceof Date
      ? r.scheduled_send_at
      : new Date(r.scheduled_send_at);
    const now = new Date();
    if (scheduled > now) {
      const diffMs = scheduled.getTime() - now.getTime();
      const diffHours = Math.round(diffMs / (1000 * 60 * 60));
      if (diffHours <= 24) {
        waiting_reason = `Waiting for send window (in ${diffHours} hours)`;
      } else {
        const diffDays = Math.round(diffHours / 24);
        waiting_reason = `Waiting for send window (in ${diffDays} days)`;
      }
    }
  }
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    contact_id: r.contact_id,
    flow_id: r.flow_id,
    flow_step_order: r.flow_step_order,
    status: r.status,
    subject: r.subject,
    body_html: r.body_html,
    preview_html: previewHtml,
    body_text: r.body_text,
    brain_reasoning: r.brain_reasoning,
    brain_action_type: r.brain_action_type,
    created_at: r.created_at,
    updated_at: r.updated_at,
    scheduled_send_at: r.scheduled_send_at,
    waiting_reason,
    flow: { name: r.flow_name ?? null, class: r.flow_class ?? null },
    status_reason: r.status_reason ?? null,
    approved_by: r.approved_by ?? null,
    rejected_by: r.rejected_by ?? null,
    edited_by: r.edited_by ?? null,
    edited_at: r.edited_at ?? null,
    original: r.edited_at
      ? { subject: r.original_subject ?? null, body_html: r.original_body_html ?? null, body_text: r.original_body_text ?? null }
      : null,
    forced_action_type: r.forced_action_type ?? null,
    context_snapshot: r.context_snapshot ?? null,
    choose: r.choose_decision ?? null,
    opening_line: r.opening_line ?? null,
    kb_entry_id: r.kb_entry_id ?? null,
    imported: r.imported === true,
    revision_request: r.revision_request ?? null,
    revisions: Array.isArray(r.revisions) ? r.revisions : [],
    contact: {
      email: r.contact_email,
      name: r.contact_name,
      external_id: r.contact_external_id,
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default function messagesRoutes() {
  const router = new RoleRouter();
  /**
   * GET /v1/messages
   *
   * List messages at pending_approval for the tenant, cursor-paginated.
   * Optionally filter by ?status= (default: pending_approval).
   *
   * Query params:
   *   ?limit=<n>       default 50, max 200
   *   ?after=<cursor>  opaque cursor from previous page's next_cursor
   *   ?status=<status> filter by message status (default: pending_approval)
   *
   * Response: { messages: [...], next_cursor: string | null }
   */
  router.get("/", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const query = c.req.query();

    const rawLimit = parseInt(query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);
    const statusFilter = query.status ?? "pending_approval";
    const { rows: pageRows, next_cursor: nextCursor } = await listMessagesPage(
      { db, tenant: c.var.tenant! },
      { status: statusFilter, limit, after: query.after },
    );

    // What the recipient's client will show (see message-preview.ts).
    const previews = await renderMessagePreviews(db, tenantId, pageRows);
    return c.json({
      messages: pageRows.map((r) => serializeMessageRow(r, previews.get(r.id)?.html ?? null)),
      next_cursor: nextCursor,
    });
  });

  // Static /bulk/* routes are registered before the /:id/* routes: Hono runs
  // matching handlers in registration order, so "/:id/approve" registered
  // first would capture "/bulk/approve" (v0.6 preferred static segments).

  /**
   * POST /v1/messages/bulk/approve
   *
   * Approve many messages at once. Body: { ids: string[] } (1-100 uuids).
   * One CAS UPDATE advances every message still at pending_approval; each
   * transitioned message gets its targeted drain enqueue, same as the
   * single-message route. Messages in any other status (or another
   * tenant's) are reported as skipped, never touched.
   *
   * Response: { approved: string[], skipped: string[] }
   */
  router.post("/bulk/approve", "member", allowAdminKey("messages"), async (c) => {
    const ids = parseBulkIds((c.var.body as { ids?: unknown } | null | undefined)?.ids);
    if (!ids) {
      return c.json({ error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` }, 400);
    }
    return c.json(await approveMessages(serviceContext(c), ids));
  });

  /**
   * POST /v1/messages/bulk/reject
   *
   * Reject many messages at once (terminal). Body: { ids: string[] }
   * (1-100 uuids). One CAS UPDATE advances every message still at
   * pending_approval; anything else is reported as skipped.
   *
   * Response: { rejected: string[], skipped: string[] }
   */
  router.post("/bulk/reject", "member", allowAdminKey("messages"), async (c) => {
    const ids = parseBulkIds((c.var.body as { ids?: unknown } | null | undefined)?.ids);
    if (!ids) {
      return c.json({ error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` }, 400);
    }
    return c.json(await rejectMessages(serviceContext(c), ids));
  });

  /**
   * POST /v1/messages/:id/approve
   *
   * Advance a message from pending_approval to approved.
   * Uses CAS: WHERE status = 'pending_approval'.
   *
   * Idempotent: if the message is already approved, returns 200 (no-op).
   * If the message does not exist or belongs to another tenant: 404.
   * If the message is in a different non-approved status: 409 Conflict.
   */
  /**
   * GET /v1/messages/:id
   *
   * One message in any status, serialized like the list (preview included),
   * with its revise thread. The dashboard follows a revision with it while
   * the message is away from pending_approval. 404 for another product's.
   */
  router.get("/:id", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const row = await storeFor(db).apiMessages.getMessage({ tenantId, messageId });
    if (!row) return c.json({ error: "Message not found." }, 404);
    const previews = await renderMessagePreviews(db, tenantId, [row]);
    return c.json({ message: serializeMessageRow(row, previews.get(row.id)?.html ?? null) });
  });

  router.post("/:id/approve", "member", allowAdminKey("messages"), async (c) => {
    const r = await approveMessage(serviceContext(c), c.req.param("id")!);
    if (r.kind === "ok") return c.json({ message: "Message approved.", id: r.id, status: "approved" });
    if (r.kind === "already") return c.json({ message: "Message already approved.", id: r.id, status: "approved" });
    return actionError(c, r, "approve");
  });

  /**
   * POST /v1/messages/:id/reject
   *
   * Reject a message (terminal). Only from pending_approval.
   * Uses CAS: WHERE status = 'pending_approval'.
   *
   * If the message is already rejected: 200 (idempotent no-op).
   * If the message does not exist or belongs to another tenant: 404.
   * If the message is in any other status: 409 Conflict.
   */
  router.post("/:id/reject", "member", allowAdminKey("messages"), async (c) => {
    const r = await rejectMessage(serviceContext(c), c.req.param("id")!);
    if (r.kind === "ok") return c.json({ message: "Message rejected.", id: r.id, status: "rejected" });
    if (r.kind === "already") return c.json({ message: "Message already rejected.", id: r.id, status: "rejected" });
    return actionError(c, r, "reject");
  });

  /**
   *
   * Re-queue a message whose content generation failed permanently
   * (status 'failed' with a brain_reasoning of 'generation_failed: ...').
   * This is the operator recovery path after fixing the configuration fault
   * the failure recorded (add an LLM provider, repair the key, fix the
   * model name). CAS: failed -> pending_generation, retry_count reset so
   * the fresh attempt gets a full reap budget.
   *
   * Send-side failures (status 'failed' without the generation_failed
   * marker) are NOT retryable here: re-running generation for a message
   * that already has approved content would discard it, and resurrecting a
   * bounced send needs a different decision. Those return 409.
   */
  router.post("/:id/retry", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;

    if (!isUuid(messageId)) {
      return c.json({ error: "Message not found." }, 404);
    }

    const now = new Date();

    if (await storeFor(db).apiMessages.requeueFailedGeneration({ tenantId, messageId, now })) {
      return c.json({ message: "Message re-queued for generation.", id: messageId, status: "pending_generation" });
    }

    const currentStatus = await storeFor(db).apiMessages.getMessageStatus({ tenantId, messageId });

    if (currentStatus === null) {
      return c.json({ error: "Message not found." }, 404);
    }

    return c.json(
      {
        error: `Cannot retry message in status '${currentStatus}'.`,
        id: messageId,
        status: currentStatus,
      },
      409,
    );
  });
  /**
   * PATCH /v1/messages/:id (G20)
   *
   * Edit a pending_approval message: { subject?, body_markdown? }. The
   * body is rendered to HTML and text like a drafted body. The content as
   * drafted stays in `original` (kept from the first edit). 409 when the
   * message is no longer pending_approval.
   */
  router.patch("/:id", "member", allowAdminKey("messages"), async (c) => {
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const body = (c.var.body ?? {}) as Record<string, unknown>;
    const invalid = editInputError(body.subject, body.body_markdown);
    if (invalid) return c.json({ error: invalid }, 400);
    const r = await editMessage(serviceContext(c), messageId, {
      subject: body.subject as string | undefined,
      markdown: body.body_markdown as string | undefined,
    });
    if (r.kind === "ok") return c.json({ message: "Message edited.", id: messageId, status: "pending_approval" });
    return actionError(c, r, "edit");
  });

  /**
   * POST /v1/messages/:id/regenerate (G20)
   *
   * Body (optional): { action_type, instruction }. Sends a pending_approval
   * message back to content generation (pending_generation). With
   * action_type the brain drafts that action and skips its decide step.
   * With instruction (revise) the brain rewrites the current draft to apply
   * the reviewer's feedback, skips decide and the value gate, and the
   * instruction joins the message's revise thread. 409 when stale.
   */
  router.post("/:id/regenerate", "member", allowAdminKey("messages"), async (c) => {
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const body = c.var.body as { action_type?: unknown; instruction?: unknown } | null | undefined;
    const raw = body?.action_type;
    if (raw !== undefined && raw !== null && (typeof raw !== "string" || !ACTION_TYPE_RE.test(raw))) {
      return c.json({ error: "'action_type' must match [a-z0-9_]{1,64}." }, 400);
    }
    const actionType = typeof raw === "string" ? raw : null;
    const rawInstruction = body?.instruction;
    if (rawInstruction !== undefined && rawInstruction !== null && typeof rawInstruction !== "string") {
      return c.json({ error: "'instruction' must be a string." }, 400);
    }
    const instruction = typeof rawInstruction === "string" && rawInstruction.trim() ? rawInstruction.trim() : null;
    if (instruction && instruction.length > REVISION_MAX_CHARS) {
      return c.json({ error: `'instruction' is longer than ${REVISION_MAX_CHARS} characters.` }, 400);
    }
    const r = await regenerateMessage(serviceContext(c), messageId, actionType, instruction);
    if (r.kind !== "ok") return actionError(c, r, "regenerate");
    return c.json({
      message: instruction ? "Message sent back for a revision." : "Message sent back for a new draft.",
      id: messageId,
      status: "pending_generation",
      forced_action_type: actionType,
      instruction,
    });
  });

  /**
   * POST /v1/messages/:id/cancel (G20)
   *
   * approved -> cancelled (terminal): an approved message that should not
   * go out. Already cancelled answers 200; any other status 409.
   */
  router.post("/:id/cancel", "member", allowAdminKey("messages"), async (c) => {
    const r = await cancelMessage(serviceContext(c), c.req.param("id")!);
    if (r.kind === "ok") return c.json({ message: "Message cancelled.", id: r.id, status: "cancelled" });
    if (r.kind === "already") return c.json({ message: "Message already cancelled.", id: r.id, status: r.status });
    return actionError(c, r, "cancel");
  });

  /**
   * POST /v1/messages/:id/unapprove (G20)
   *
   * approved -> pending_approval: pull an approved message back to review.
   * 409 when it is no longer approved (for example already sending).
   */
  router.post("/:id/unapprove", "member", allowAdminKey("messages"), async (c) => {
    const r = await unapproveMessage(serviceContext(c), c.req.param("id")!);
    if (r.kind !== "ok") return actionError(c, r, "unapprove");
    return c.json({ message: "Message back in review.", id: r.id, status: "pending_approval" });
  });

  return router.app;
}

function serviceContext(c: AppContext): ServiceContext {
  return { db: c.var.db, tenant: c.var.tenant!, enqueue: c.var.enqueue };
}

/** 404 for an unknown message, else 409 naming its current status. */
function actionError(c: AppContext, r: MessageActionResult, action: string): Response {
  if (r.kind === "not_found") return c.json({ error: "Message not found." }, 404);
  const status = r.kind === "ok" ? "" : r.status;
  return c.json({ error: `Cannot ${action} message in status '${status}'.`, id: r.id, status }, 409);
}
