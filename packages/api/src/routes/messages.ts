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
 *
 * CAS conventions: approve and reject use WHERE status = 'pending_approval'
 * to guarantee atomic state transitions. Approving an already-approved message
 * returns 200 (idempotent no-op). Rejecting a non-pending_approval message
 * returns 409 (terminal means no going back).
 *
 * Tenant isolation: messages belonging to another tenant return 404.
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import { QUEUE } from "@claros/core";

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
};

function serializeMessageRow(r: MessageListRow) {
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
    body_text: r.body_text,
    brain_reasoning: r.brain_reasoning,
    brain_action_type: r.brain_action_type,
    created_at: r.created_at,
    updated_at: r.updated_at,
    scheduled_send_at: r.scheduled_send_at,
    waiting_reason,
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
}

function encodeCursor(createdAt: Date | string | null | undefined, id: string): string {
  const ts = createdAt instanceof Date
    ? createdAt.toISOString()
    : (createdAt ?? new Date(0).toISOString());
  const payload: CursorPayload = { created_at: ts, id };
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
// Route plugin
// ---------------------------------------------------------------------------

const messagesRoutes: FastifyPluginAsync = async (app) => {
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
  app.get<{
    Querystring: { limit?: string; after?: string; status?: string };
  }>("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rawLimit = parseInt(request.query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);
    const fetchLimit = limit + 1;

    const statusFilter = request.query.status ?? "pending_approval";

    let cursor: CursorPayload | null = null;
    if (request.query.after) {
      cursor = decodeCursor(request.query.after);
    }

    let rows: MessageListRow[];

    if (cursor) {
      const result = await db.execute<MessageListRow>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
               m.status, m.subject, m.body_html, m.body_text,
               m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
               m.scheduled_send_at,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.status = ${statusFilter}
          AND ROW(m.created_at, m.id) > ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${fetchLimit}
      `);
      rows = result.rows;
    } else {
      const result = await db.execute<MessageListRow>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
               m.status, m.subject, m.body_html, m.body_text,
               m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
               m.scheduled_send_at,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.status = ${statusFilter}
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${fetchLimit}
      `);
      rows = result.rows;
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.created_at, lastRow.id)
      : null;

    return {
      messages: pageRows.map(serializeMessageRow),
      next_cursor: nextCursor,
    };
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
  app.post<{
    Params: { id: string };
  }>("/:id/approve", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const messageId = request.params.id;

    // Validate UUID format to avoid Postgres errors
    if (!isUuid(messageId)) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> approved
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'approved', approved_at = ${now}, updated_at = ${now}
      WHERE id = ${messageId}
        AND tenant_id = ${tenantId}
        AND status = 'pending_approval'
      RETURNING id
    `);

    if (casResult.rows.length > 0) {
      // Transition succeeded - enqueue targeted drain for immediate send
      const enqueue = request.server.enqueue;
      if (enqueue) {
        await enqueue(
          QUEUE.DRAIN_MESSAGE,
          { tenant_id: tenantId, message_id: messageId },
          { singletonKey: messageId, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
        ).catch(() => {});
      }
      return { message: "Message approved.", id: messageId, status: "approved" };
    }

    // CAS did not match. Determine why: not found, wrong tenant, or different status.
    const existing = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `);

    if (existing.rows.length === 0) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const currentStatus = existing.rows[0]!.status;

    // Idempotent: already approved is a no-op
    if (currentStatus === "approved") {
      return { message: "Message already approved.", id: messageId, status: "approved" };
    }

    // Any other status: conflict (e.g., already sent, rejected, etc.)
    reply.status(409);
    return {
      error: `Cannot approve message in status '${currentStatus}'.`,
      id: messageId,
      status: currentStatus,
    };
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
  app.post<{
    Params: { id: string };
  }>("/:id/reject", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const messageId = request.params.id;

    if (!isUuid(messageId)) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> rejected
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'rejected', updated_at = ${now}
      WHERE id = ${messageId}
        AND tenant_id = ${tenantId}
        AND status = 'pending_approval'
      RETURNING id
    `);

    if (casResult.rows.length > 0) {
      return { message: "Message rejected.", id: messageId, status: "rejected" };
    }

    // Determine cause of CAS failure
    const existing = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `);

    if (existing.rows.length === 0) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const currentStatus = existing.rows[0]!.status;

    // Idempotent: already rejected is a no-op
    if (currentStatus === "rejected") {
      return { message: "Message already rejected.", id: messageId, status: "rejected" };
    }

    // Any other status: conflict
    reply.status(409);
    return {
      error: `Cannot reject message in status '${currentStatus}'.`,
      id: messageId,
      status: currentStatus,
    };
  });

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
  app.post<{
    Body: { ids?: unknown };
  }>("/bulk/approve", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const ids = parseBulkIds(request.body?.ids);
    if (!ids) {
      reply.status(400);
      return { error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` };
    }

    const now = new Date();
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'approved', approved_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${tenantId}
        AND status = 'pending_approval'
        AND id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
      RETURNING id
    `);

    const approved = casResult.rows.map((r) => r.id);

    const enqueue = request.server.enqueue;
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
    return {
      approved,
      skipped: ids.filter((id) => !approvedSet.has(id)),
    };
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
  app.post<{
    Body: { ids?: unknown };
  }>("/bulk/reject", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const ids = parseBulkIds(request.body?.ids);
    if (!ids) {
      reply.status(400);
      return { error: `Body must be { ids: string[] } with 1-${BULK_MAX_IDS} uuid values.` };
    }

    const now = new Date();
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'rejected', updated_at = ${now}
      WHERE tenant_id = ${tenantId}
        AND status = 'pending_approval'
        AND id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
      RETURNING id
    `);

    const rejected = casResult.rows.map((r) => r.id);
    const rejectedSet = new Set(rejected);
    return {
      rejected,
      skipped: ids.filter((id) => !rejectedSet.has(id)),
    };
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
  app.post<{
    Params: { id: string };
  }>("/:id/retry", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const messageId = request.params.id;

    if (!isUuid(messageId)) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const now = new Date();

    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'pending_generation', retry_count = 0, updated_at = ${now}
      WHERE id = ${messageId}
        AND tenant_id = ${tenantId}
        AND status = 'failed'
        AND brain_reasoning LIKE 'generation_failed:%'
      RETURNING id
    `);

    if (casResult.rows.length > 0) {
      return { message: "Message re-queued for generation.", id: messageId, status: "pending_generation" };
    }

    const existing = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `);

    if (existing.rows.length === 0) {
      reply.status(404);
      return { error: "Message not found." };
    }

    reply.status(409);
    return {
      error: `Cannot retry message in status '${existing.rows[0]!.status}'.`,
      id: messageId,
      status: existing.rows[0]!.status,
    };
  });
};

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

export default messagesRoutes;
