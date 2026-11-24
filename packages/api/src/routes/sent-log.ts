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
import { sql } from "drizzle-orm";
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
   *   ?status=<status>    filter by status (sent|failed|suppressed|sending)
   *   ?flow_id=<uuid>     filter by flow
   *   ?recipient=<text>   ILIKE search on recipient_address, contact email, or name
   *   ?from=<ISO date>    filter sent_at >= from
   *   ?to=<ISO date>      filter sent_at <= to
   *   ?feedback=<value>   filter by feedback (opened|clicked|bounced|complained)
   *
   * Response: { messages: [...], next_cursor: string | null }
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

    // Build WHERE conditions
    const conditions: ReturnType<typeof sql>[] = [
      sql`m.tenant_id = ${tenantId}`,
    ];

    // Status filter: default shows all sent-log statuses
    const statusParam = query.status;
    if (statusParam && SENT_LOG_STATUSES.includes(statusParam)) {
      conditions.push(sql`m.status = ${statusParam}`);
    } else {
      conditions.push(
        sql`m.status IN ('sending', 'sent', 'failed', 'suppressed')`
      );
    }

    // Flow filter
    if (query.flow_id && isUuid(query.flow_id)) {
      conditions.push(sql`m.flow_id = ${query.flow_id}::uuid`);
    }

    // Recipient search (ILIKE on address, contact email, or contact name)
    if (query.recipient && query.recipient.trim().length > 0) {
      const pattern = `%${query.recipient.trim()}%`;
      conditions.push(
        sql`(
          m.recipient_address ILIKE ${pattern}
          OR c.email ILIKE ${pattern}
          OR c.name ILIKE ${pattern}
        )`
      );
    }

    // Date range on sent_at
    if (query.from) {
      conditions.push(sql`m.sent_at >= ${query.from}::timestamptz`);
    }
    if (query.to) {
      conditions.push(sql`m.sent_at <= ${query.to}::timestamptz`);
    }

    // Feedback filter
    const feedbackParam = query.feedback;
    if (
      feedbackParam &&
      ["opened", "clicked", "bounced", "complained"].includes(feedbackParam)
    ) {
      if (feedbackParam === "opened") {
        // opened-or-better (includes clicked)
        conditions.push(sql`m.feedback IN ('opened', 'clicked')`);
      } else {
        conditions.push(sql`m.feedback = ${feedbackParam}`);
      }
    }

    // Cursor
    let cursor: CursorPayload | null = null;
    if (query.after) {
      cursor = decodeCursor(query.after);
    }
    if (cursor) {
      // DESC order: next page has OLDER messages
      conditions.push(
        sql`ROW(date_trunc('milliseconds', m.sent_at), m.id) < ROW(${cursor.sent_at}::timestamptz, ${cursor.id}::uuid)`
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);

    type SentLogRow = {
      id: string;
      tenant_id: string;
      contact_id: string;
      flow_id: string;
      flow_name: string | null;
      status: string;
      feedback: string | null;
      subject: string | null;
      recipient_address: string | null;
      sent_at: string | null;
      created_at: string | null;
      contact_email: string | null;
      contact_name: string | null;
      contact_external_id: string | null;
    };

    const result = await db.execute<SentLogRow>(sql`
      SELECT m.id, m.tenant_id, m.contact_id, m.flow_id,
             f.name AS flow_name,
             m.status, m.feedback, m.subject, m.recipient_address,
             m.sent_at, m.created_at,
             c.email AS contact_email, c.name AS contact_name,
             c.external_id AS contact_external_id
      FROM lifecycle_messages m
      LEFT JOIN contacts c
        ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
      LEFT JOIN flows f
        ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
      WHERE ${whereClause}
      ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
      LIMIT ${fetchLimit}
    `);

    const rows = result.rows;
    const hasNextPage = rows.length > limit;
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

    type DetailRow = {
      id: string;
      tenant_id: string;
      contact_id: string;
      flow_id: string;
      flow_name: string | null;
      membership_id: string;
      flow_step_order: number | null;
      status: string;
      feedback: string | null;
      subject: string | null;
      body_html: string | null;
      body_text: string | null;
      brain_reasoning: string | null;
      brain_action_type: string | null;
      scheduled_send_at: string | null;
      approved_at: string | null;
      sent_at: string | null;
      created_at: string | null;
      updated_at: string | null;
      retry_count: number;
      provider_message_id: string | null;
      recipient_address: string | null;
      contact_email: string | null;
      contact_name: string | null;
      contact_external_id: string | null;
    };

    const msgResult = await db.execute<DetailRow>(sql`
      SELECT m.id, m.tenant_id, m.contact_id, m.flow_id,
             f.name AS flow_name,
             m.membership_id, m.flow_step_order,
             m.status, m.feedback, m.subject, m.body_html, m.body_text,
             m.brain_reasoning, m.brain_action_type,
             m.scheduled_send_at, m.approved_at, m.sent_at,
             m.created_at, m.updated_at, m.retry_count,
             m.provider_message_id, m.recipient_address,
             c.email AS contact_email, c.name AS contact_name,
             c.external_id AS contact_external_id
      FROM lifecycle_messages m
      LEFT JOIN contacts c
        ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
      LEFT JOIN flows f
        ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
      WHERE m.id = ${messageId}::uuid
        AND m.tenant_id = ${tenantId}
    `);

    if (msgResult.rows.length === 0) {
      return c.json({ error: "Message not found." }, 404);
    }

    const msg = msgResult.rows[0]!;

    // Fetch event timeline (all events, ordered chronologically)
    type EventRow = {
      id: string;
      event_type: string;
      occurred_at: string;
      metadata: unknown;
      created_at: string;
    };

    const eventsResult = await db.execute<EventRow>(sql`
      SELECT id, event_type, occurred_at, metadata, created_at
      FROM message_events
      WHERE message_id = ${messageId}::uuid
        AND tenant_id = ${tenantId}
      ORDER BY occurred_at ASC
      LIMIT 100
    `);

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
        contact: {
          email: msg.contact_email,
          name: msg.contact_name,
          external_id: msg.contact_external_id,
        },
      },
      events: eventsResult.rows.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        metadata: e.metadata,
      })),
    });
  });
  return router.app;
}
