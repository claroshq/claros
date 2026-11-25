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
 *   POST  /v1/messages/:id/regenerate  new draft, optionally forcing the action type (G20)
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
  QUEUE,
  pendingApprovalBatch,
  wrapInShell,
  buildShellComplianceHtml,
  stepPresentation,
  type BrandSettings,
} from "@claros/core";
import { renderMarkdownToHtml, markdownToText } from "@claros/brain-oss";
import { actorOf } from "../http/admin-auth.js";
import type { AppContext } from "../http/env.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for GET /v1/messages list. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for GET /v1/messages list. */
const MAX_PAGE_SIZE = 200;

/** Maximum ids accepted by the bulk approve/reject endpoints. */
const BULK_MAX_IDS = 100;

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
};

/**
 * What the recipient's client will show: the body in the product's branded
 * shell (brand, eyebrow, preheader, footer), rendered the same way as the
 * drain does at send time. Only the unsubscribe link is a placeholder; the
 * real one is signed per message when it is sent. Link tracking (UTM) is
 * not applied. Null when the message has no HTML body.
 */
async function buildPreviews(db: Db, tenantId: string, rows: MessageListRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.some((r) => r.body_html)) return out;
  const tenant = await storeFor(db).workerDrain.getTenant(tenantId);
  const settings = (tenant?.settings as Record<string, unknown> | null) ?? {};
  const brand = (settings.brand as BrandSettings | undefined) ?? {};
  const addr = typeof settings.postal_address === "string" ? settings.postal_address.trim() : "";
  const footer = buildShellComplianceHtml(
    "#",
    addr || "No postal address set. Mail is held until one is set in Settings.",
    tenant?.locale ?? null,
  );
  const plans = new Map<string, unknown>();
  for (const flowId of new Set(rows.filter((r) => r.body_html).map((r) => r.flow_id))) {
    const flow = await storeFor(db).apiFlows.findFlow({ tenantId, id: flowId });
    plans.set(flowId, flow?.compiledPlan ?? null);
  }
  for (const r of rows) {
    if (!r.body_html) continue;
    const presentation = stepPresentation(plans.get(r.flow_id) ?? null, r.flow_step_order, r.brain_action_type);
    out.set(r.id, wrapInShell({
      bodyHtml: r.body_html,
      brand,
      tenantName: tenant?.name ?? "Our Team",
      complianceFooterHtml: footer,
      eyebrow: presentation.eyebrow,
      preheader: presentation.preheader,
    }));
  }
  return out;
}

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
    contact: {
      email: r.contact_email,
      name: r.contact_name,
      external_id: r.contact_external_id,
    },
  };
}

// ---------------------------------------------------------------------------
// Cursor helpers (same convention as GET /v1/suppressions and GET /v1/kb)
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
  /** 0 = critical-class flow, 1 = other (G20 order); absent in older cursors. */
  rank?: number;
}

function encodeCursor(createdAt: Date | string | null | undefined, id: string, rank: number): string {
  const ts = createdAt instanceof Date
    ? createdAt.toISOString()
    : (createdAt ?? new Date(0).toISOString());
  const payload: CursorPayload = { created_at: ts, id, rank };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
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
    const fetchLimit = limit + 1;

    const statusFilter = query.status ?? "pending_approval";

    let cursor: CursorPayload | null = null;
    if (query.after) {
      cursor = decodeCursor(query.after);
    }

    const rows = await storeFor(db).apiMessages.listMessages({
      tenantId,
      status: statusFilter,
      after: cursor
        ? { createdAt: cursor.created_at, id: cursor.id, rank: typeof cursor.rank === "number" ? cursor.rank : 1 }
        : null,
      limit: fetchLimit,
    });

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.created_at, lastRow.id, lastRow.flow_class === "critical" ? 0 : 1)
      : null;

    const previews = await buildPreviews(db, tenantId, pageRows);
    return c.json({
      messages: pageRows.map((r) => serializeMessageRow(r, previews.get(r.id) ?? null)),
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
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const ids = parseBulkIds((c.var.body as { ids?: unknown } | null | undefined)?.ids);
    if (!ids) {
      return c.json({ error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` }, 400);
    }

    const now = new Date();
    const approved = await storeFor(db).apiMessages.approveMessages({ tenantId, ids, now, actor: actorOf(c.var.tenant!) });

    const enqueue = c.var.enqueue;
    if (enqueue) {
      for (const id of approved) {
        await enqueue(
          QUEUE.DRAIN_MESSAGE,
          { tenant_id: tenantId, message_id: id },
          { singletonKey: id, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
        ).catch(() => {});
      }
    }

    const approvedSet = new Set(approved);
    return c.json({
      approved,
      skipped: ids.filter((id) => !approvedSet.has(id)),
    });
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
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const ids = parseBulkIds((c.var.body as { ids?: unknown } | null | undefined)?.ids);
    if (!ids) {
      return c.json({ error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` }, 400);
    }

    const now = new Date();
    const rejected = await storeFor(db).apiMessages.rejectMessages({ tenantId, ids, now, actor: actorOf(c.var.tenant!) });
    const rejectedSet = new Set(rejected);
    return c.json({
      rejected,
      skipped: ids.filter((id) => !rejectedSet.has(id)),
    });
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
  router.post("/:id/approve", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;

    // Validate UUID format to avoid Postgres errors
    if (!isUuid(messageId)) {
      return c.json({ error: "Message not found." }, 404);
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> approved
    if (await storeFor(db).apiMessages.approveMessage({ tenantId, messageId, now, actor: actorOf(c.var.tenant!) })) {
      // Transition succeeded - enqueue targeted drain for immediate send
      const enqueue = c.var.enqueue;
      if (enqueue) {
        await enqueue(
          QUEUE.DRAIN_MESSAGE,
          { tenant_id: tenantId, message_id: messageId },
          { singletonKey: messageId, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
        ).catch(() => {});
      }
      return c.json({ message: "Message approved.", id: messageId, status: "approved" });
    }

    // CAS did not match. Determine why: not found, wrong tenant, or different status.
    const currentStatus = await storeFor(db).apiMessages.getMessageStatus({ tenantId, messageId });

    if (currentStatus === null) {
      return c.json({ error: "Message not found." }, 404);
    }

    // Idempotent: already approved is a no-op
    if (currentStatus === "approved") {
      return c.json({ message: "Message already approved.", id: messageId, status: "approved" });
    }

    // Any other status: conflict (e.g., already sent, rejected, etc.)
    return c.json(
      {
        error: `Cannot approve message in status '${currentStatus}'.`,
        id: messageId,
        status: currentStatus,
      },
      409,
    );
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
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;

    if (!isUuid(messageId)) {
      return c.json({ error: "Message not found." }, 404);
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> rejected
    if (await storeFor(db).apiMessages.rejectMessage({ tenantId, messageId, now, actor: actorOf(c.var.tenant!) })) {
      return c.json({ message: "Message rejected.", id: messageId, status: "rejected" });
    }

    // Determine cause of CAS failure
    const currentStatus = await storeFor(db).apiMessages.getMessageStatus({ tenantId, messageId });

    if (currentStatus === null) {
      return c.json({ error: "Message not found." }, 404);
    }

    // Idempotent: already rejected is a no-op
    if (currentStatus === "rejected") {
      return c.json({ message: "Message already rejected.", id: messageId, status: "rejected" });
    }

    // Any other status: conflict
    return c.json(
      {
        error: `Cannot reject message in status '${currentStatus}'.`,
        id: messageId,
        status: currentStatus,
      },
      409,
    );
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
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const body = (c.var.body ?? {}) as Record<string, unknown>;
    const subject = body.subject;
    const markdown = body.body_markdown;
    if (subject === undefined && markdown === undefined) {
      return c.json({ error: "Body must contain 'subject' and/or 'body_markdown'." }, 400);
    }
    if (subject !== undefined && (typeof subject !== "string" || subject.trim().length === 0 || subject.length > 300)) {
      return c.json({ error: "'subject' must be a non-empty string of at most 300 characters." }, 400);
    }
    if (markdown !== undefined && (typeof markdown !== "string" || markdown.trim().length === 0 || markdown.length > 50_000)) {
      return c.json({ error: "'body_markdown' must be a non-empty string of at most 50000 characters." }, 400);
    }
    const current = await storeFor(db).apiMessages.getMessageContent({ tenantId, messageId });
    if (!current) return c.json({ error: "Message not found." }, 404);
    if (current.status !== "pending_approval") {
      return c.json({ error: `Cannot edit message in status '${current.status}'.`, id: messageId, status: current.status }, 409);
    }
    const edited = await storeFor(db).apiMessages.editMessage({
      tenantId,
      messageId,
      subject: typeof subject === "string" ? subject.trim() : current.subject ?? "",
      bodyHtml: typeof markdown === "string" ? renderMarkdownToHtml(markdown) : current.bodyHtml ?? "",
      bodyText: typeof markdown === "string" ? markdownToText(markdown) : current.bodyText ?? "",
      actor: actorOf(c.var.tenant!),
      now: new Date(),
    });
    if (!edited) return stale(c, db, tenantId, messageId, "edit");
    return c.json({ message: "Message edited.", id: messageId, status: "pending_approval" });
  });

  /**
   * POST /v1/messages/:id/regenerate (G20)
   *
   * Body (optional): { action_type }. Sends a pending_approval message back
   * to content generation (pending_generation). With action_type the brain
   * drafts that action and skips its decide step. 409 when stale.
   */
  router.post("/:id/regenerate", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const raw = (c.var.body as { action_type?: unknown } | null | undefined)?.action_type;
    if (raw !== undefined && raw !== null && (typeof raw !== "string" || !/^[a-z0-9_]{1,64}$/.test(raw))) {
      return c.json({ error: "'action_type' must match [a-z0-9_]{1,64}." }, 400);
    }
    const actionType = typeof raw === "string" ? raw : null;
    const ok = await storeFor(db).apiMessages.regenerateMessage({ tenantId, messageId, actionType, now: new Date() });
    if (!ok) return stale(c, db, tenantId, messageId, "regenerate");
    const enqueue = c.var.enqueue;
    if (enqueue) {
      await enqueue(
        QUEUE.PROCESS_MESSAGE,
        { tenant_id: tenantId, message_id: messageId },
        { singletonKey: messageId, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
      ).catch(() => {});
    }
    return c.json({ message: "Message sent back for a new draft.", id: messageId, status: "pending_generation", forced_action_type: actionType });
  });

  /**
   * POST /v1/messages/:id/cancel (G20)
   *
   * approved -> cancelled (terminal): an approved message that should not
   * go out. Already cancelled answers 200; any other status 409.
   */
  router.post("/:id/cancel", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    if (await storeFor(db).apiMessages.cancelMessage({ tenantId, messageId, actor: actorOf(c.var.tenant!), now: new Date() })) {
      return c.json({ message: "Message cancelled.", id: messageId, status: "cancelled" });
    }
    const status = await storeFor(db).apiMessages.getMessageStatus({ tenantId, messageId });
    if (status === "cancelled") return c.json({ message: "Message already cancelled.", id: messageId, status });
    return stale(c, db, tenantId, messageId, "cancel", status);
  });

  /**
   * POST /v1/messages/:id/unapprove (G20)
   *
   * approved -> pending_approval: pull an approved message back to review.
   * 409 when it is no longer approved (for example already sending).
   */
  router.post("/:id/unapprove", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;
    if (!isUuid(messageId)) return c.json({ error: "Message not found." }, 404);
    const now = new Date();
    const batch = pendingApprovalBatch(now);
    const ok = await storeFor(db).apiMessages.unapproveMessage({
      tenantId,
      messageId,
      now,
      outbox: [{ event: "message.pending_approval", payload: { message_id: messageId }, dedupKey: batch.dedupKey, deliverAt: batch.deliverAt, batched: true }],
    });
    if (!ok) return stale(c, db, tenantId, messageId, "unapprove");
    return c.json({ message: "Message back in review.", id: messageId, status: "pending_approval" });
  });

  return router.app;
}

/** 404 for an unknown message, else 409 naming its current status. */
async function stale(
  c: AppContext,
  db: Db,
  tenantId: string,
  messageId: string,
  action: string,
  known?: string | null,
): Promise<Response> {
  const status = known !== undefined ? known : await storeFor(db).apiMessages.getMessageStatus({ tenantId, messageId });
  if (status === null) return c.json({ error: "Message not found." }, 404);
  return c.json({ error: `Cannot ${action} message in status '${status}'.`, id: messageId, status }, 409);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Validate a bulk-endpoint ids array: 1..BULK_MAX_IDS unique uuids. */
function parseBulkIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BULK_MAX_IDS) {
    return null;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isUuid(item)) return null;
    ids.push(item);
  }
  return [...new Set(ids)];
}
