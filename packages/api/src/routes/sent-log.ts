/**
 * Sent-mail log routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under /v1/sent-log inside the authenticated scope.
 *
 * Endpoints:
 *   GET /v1/sent-log             list messages that left the drafting stage
 *   GET /v1/sent-log/:id         single message detail with event timeline
 *   GET /v1/sent-log/:id/events  event timeline for a message (paginated)
 *
 * This is the operator's sent-mail log: what went out, to whom, when, and what
 * happened after. It covers messages with status in (sending, sent, failed,
 * suppressed) - everything that left the approval/generation pipeline.
 *
 * Filtering: status, flow_id, recipient (ILIKE on recipient_address or
 * contact email/name), date range on sent_at. All filters are optional.
 *
 * Search cost: recipient search uses ILIKE which requires a sequential scan on
 * the matched subset. At the scale this product targets (tens of thousands of
 * messages per tenant, not millions), this is acceptable. If a tenant reaches
 * scale where ILIKE is slow, a pg_trgm GIN index on recipient_address would
 * fix it without schema changes. Not added now (premature).
 */
import { storeFor } from "@claros/store";
import { compiledPlanSchema, planStepFor } from "@claros/core";
import type { Db } from "../plugins/db.js";
import { RoleRouter } from "../http/router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Statuses that appear in the sent-mail log: messages that have left the
 * drafting/approval pipeline. Includes failed and suppressed because the
 * operator needs to see delivery failures.
 */
const SENT_LOG_STATUSES = ["sending", "sent", "failed", "suppressed"];

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  sent_at: string;
  id: string;
}

function encodeCursor(sentAt: Date | string | null | undefined, id: string): string {
  const ts =
    sentAt instanceof Date
      ? sentAt.toISOString()
      : sentAt ?? new Date(0).toISOString();
  const payload: CursorPayload = { sent_at: ts, id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).sent_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    )
      return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default function sentLogRoutes() {
  const router = new RoleRouter();
  /**
   * GET /v1/sent-log
   *
   * List messages that have left the drafting stage, cursor-paginated.
   * Default sort: most recent sent_at first (DESC).
   *
   * Query params:
   *   ?limit=<n>          default 50, max 200
   *   ?after=<cursor>     opaque cursor from previous page's next_cursor
   *   ?page=<n>           numbered page (1-based) instead of a cursor; the
   *                       response then also carries page, page_size and total
   *   ?status=<status>    filter by status (sent|failed|suppressed|sending)
   *   ?flow_id=<uuid>     filter by flow
   *   ?recipient=<text>   ILIKE search on recipient_address, contact email, or name
   *   ?from=<ISO date>    filter sent_at >= from
   *   ?to=<ISO date>      filter sent_at <= to
   *   ?feedback=<value>   filter by feedback (opened|clicked|bounced|complained)
   *
   * Response: { messages: [...], next_cursor: string | null }
   *   with ?page: { messages, next_cursor: null, page, page_size, total }
   */
  router.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const query = c.req.query();

    const rawLimit = parseInt(query.limit ?? "", 10);
    const limit =
      isNaN(rawLimit) || rawLimit < 1
        ? DEFAULT_PAGE_SIZE
        : Math.min(rawLimit, MAX_PAGE_SIZE);
    const fetchLimit = limit + 1;

    // Status filter: default shows all sent-log statuses
    const statusParam = query.status;
    const status = statusParam && SENT_LOG_STATUSES.includes(statusParam) ? statusParam : null;

    // Flow filter
    const flowId = query.flow_id && isUuid(query.flow_id) ? query.flow_id : null;

    // Recipient search (ILIKE on address, contact email, or contact name)
    const recipient =
      query.recipient && query.recipient.trim().length > 0 ? query.recipient.trim() : null;

    // Feedback filter (opened means opened-or-better, includes clicked)
    const feedbackParam = query.feedback;
    const feedback =
      feedbackParam &&
      ["opened", "clicked", "bounced", "complained"].includes(feedbackParam)
        ? feedbackParam
        : null;

    // Numbered page (1-based). Takes precedence over the cursor.
    const rawPage = parseInt(query.page ?? "", 10);
    const page = query.page === undefined ? null : isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

    // Cursor
    let cursor: CursorPayload | null = null;
    if (query.after && page === null) {
      cursor = decodeCursor(query.after);
    }

    const filter = {
      status,
      flowId,
      recipient,
      // Date range on sent_at
      from: query.from || null,
      to: query.to || null,
      // DESC order: next page has OLDER messages
      before: cursor ? { sentAt: cursor.sent_at, id: cursor.id } : null,
      feedback,
    };
    const store = storeFor(db).apiSentLog;
    const [rows, total] = await Promise.all([
      store.listSentMessages({
        tenantId,
        filter,
        limit: page === null ? fetchLimit : limit,
        offset: page === null ? 0 : (page - 1) * limit,
      }),
      page === null ? Promise.resolve(null) : store.countSentMessages({ tenantId, filter }),
    ]);

    const hasNextPage = page === null && rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor(lastRow.sent_at, lastRow.id)
        : null;

    return c.json({
      messages: pageRows.map((r) => ({
        id: r.id,
        contact_id: r.contact_id,
        flow_id: r.flow_id,
        flow_name: r.flow_name,
        status: r.status,
        feedback: r.feedback,
        subject: r.subject,
        recipient_address: r.recipient_address,
        sent_at: r.sent_at,
        created_at: r.created_at,
        contact: {
          email: r.contact_email,
          name: r.contact_name,
          external_id: r.contact_external_id,
        },
      })),
      next_cursor: nextCursor,
      ...(page !== null && { page, page_size: limit, total }),
    });
  });

  /**
   * GET /v1/sent-log/:id
   *
   * Single message detail: envelope, content, and event timeline.
   * Returns the full message row plus the most recent events (up to 100).
   */
  router.get("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const messageId = c.req.param("id")!;

    if (!isUuid(messageId)) {
      return c.json({ error: "Message not found." }, 404);
    }

    const msg = await storeFor(db).apiSentLog.getSentMessage({ tenantId, messageId });

    if (msg === null) {
      return c.json({ error: "Message not found." }, 404);
    }

    // Fetch event timeline (all events, ordered chronologically)
    const events = await storeFor(db).apiSentLog.listMessageEvents({ tenantId, messageId });

    return c.json({
      message: {
        id: msg.id,
        contact_id: msg.contact_id,
        flow_id: msg.flow_id,
        flow_name: msg.flow_name,
        membership_id: msg.membership_id,
        flow_step_order: msg.flow_step_order,
        status: msg.status,
        feedback: msg.feedback,
        subject: msg.subject,
        body_html: msg.body_html,
        body_text: msg.body_text,
        brain_reasoning: msg.brain_reasoning,
        brain_action_type: msg.brain_action_type,
        scheduled_send_at: msg.scheduled_send_at,
        approved_at: msg.approved_at,
        sent_at: msg.sent_at,
        created_at: msg.created_at,
        updated_at: msg.updated_at,
        retry_count: msg.retry_count,
        provider_message_id: msg.provider_message_id,
        recipient_address: msg.recipient_address,
        template_ref: messageTemplateRef(msg.flow_compiled_plan, msg.flow_step_order, msg.brain_action_type),
        contact: {
          email: msg.contact_email,
          name: msg.contact_name,
          external_id: msg.contact_external_id,
        },
      },
      events: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        metadata: e.metadata,
      })),
    });
  });
  return router.app;
}

/**
 * The template the message's step renders from, read from the flow's current
 * plan: the step's template_ref, or for a choose step the template of the
 * candidate it picked (matched by action type). Null for AI-drafted steps and
 * plans that no longer parse. The template may have been edited since the
 * message was sent; the message body is what was sent.
 */
function messageTemplateRef(plan: unknown, stepOrder: number | null, actionType: string | null): string | null {
  if (stepOrder === null || plan === null || plan === undefined) return null;
  const parsed = compiledPlanSchema.safeParse(plan);
  if (!parsed.success) return null;
  const step = planStepFor(parsed.data, stepOrder);
  if (!step) return null;
  if (step.type === "choose") {
    const cand = step.candidates?.find((c) => c.action_type === actionType);
    return cand?.template_ref ?? null;
  }
  return step.template_ref ?? null;
}
