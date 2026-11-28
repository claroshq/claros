/**
 * Approval actions on messages, shared by the HTTP routes (routes/messages.ts)
 * and the MCP tools (mcp/tools.ts).
 *
 * Every transition is the store's compare-and-swap on the current status;
 * this module only decides what a failed swap means (not found, already in
 * the target status, or moved on) and does the follow-up work the route did
 * (drain or generation enqueue, the pending_approval outbox entry). Callers
 * map the result to their own answer: an HTTP status or an MCP tool result.
 */
import { storeFor, type MessageListRow } from "@claros/store";
import { QUEUE, pendingApprovalBatch } from "@claros/core";
import { renderMarkdownToHtml, markdownToText } from "@claros/brain-oss";
import type { Db, EnqueueFn } from "../plugins/db.js";
import type { TenantContext } from "../types.js";
import { actorOf } from "../http/admin-auth.js";

export interface ServiceContext {
  db: Db;
  tenant: TenantContext;
  enqueue?: EnqueueFn;
}

/**
 * Outcome of an action on one message:
 * - ok: this call made the transition;
 * - already: the message was already in the target status (no change);
 * - conflict: the message is in another status (it moved on), nothing changed;
 * - not_found: no such message in this product.
 */
export type MessageActionResult =
  | { kind: "ok"; id: string; status: string }
  | { kind: "already"; id: string; status: string }
  | { kind: "conflict"; id: string; status: string }
  | { kind: "not_found"; id: string };

export const BULK_MAX_IDS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function settle(
  ctx: ServiceContext,
  id: string,
  already: string | null,
  known?: string | null,
): Promise<MessageActionResult> {
  const status = known !== undefined ? known : await storeFor(ctx.db).apiMessages.getMessageStatus({ tenantId: ctx.tenant.id, messageId: id });
  if (status === null) return { kind: "not_found", id };
  if (already !== null && status === already) return { kind: "already", id, status };
  return { kind: "conflict", id, status };
}

async function enqueueDrain(ctx: ServiceContext, id: string): Promise<void> {
  if (!ctx.enqueue) return;
  await ctx.enqueue(
    QUEUE.DRAIN_MESSAGE,
    { tenant_id: ctx.tenant.id, message_id: id },
    { singletonKey: id, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
  ).catch(() => {});
}

/** pending_approval -> approved, then a targeted drain (the normal send checks apply). */
export async function approveMessage(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const moved = await storeFor(ctx.db).apiMessages.approveMessage({ tenantId: ctx.tenant.id, messageId: id, now: new Date(), actor: actorOf(ctx.tenant) });
  if (moved) {
    await enqueueDrain(ctx, id);
    return { kind: "ok", id, status: "approved" };
  }
  return settle(ctx, id, "approved");
}

/** pending_approval -> rejected (terminal). */
export async function rejectMessage(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const moved = await storeFor(ctx.db).apiMessages.rejectMessage({ tenantId: ctx.tenant.id, messageId: id, now: new Date(), actor: actorOf(ctx.tenant) });
  if (moved) return { kind: "ok", id, status: "rejected" };
  return settle(ctx, id, "rejected");
}

/** Many ids at once: one CAS for all; the ids that did not move are `skipped`. */
export async function approveMessages(ctx: ServiceContext, ids: string[]): Promise<{ approved: string[]; skipped: string[] }> {
  const approved = await storeFor(ctx.db).apiMessages.approveMessages({ tenantId: ctx.tenant.id, ids, now: new Date(), actor: actorOf(ctx.tenant) });
  for (const id of approved) await enqueueDrain(ctx, id);
  const done = new Set(approved);
  return { approved, skipped: ids.filter((id) => !done.has(id)) };
}

export async function rejectMessages(ctx: ServiceContext, ids: string[]): Promise<{ rejected: string[]; skipped: string[] }> {
  const rejected = await storeFor(ctx.db).apiMessages.rejectMessages({ tenantId: ctx.tenant.id, ids, now: new Date(), actor: actorOf(ctx.tenant) });
  const done = new Set(rejected);
  return { rejected, skipped: ids.filter((id) => !done.has(id)) };
}

/**
 * Bulk approve or reject with each id's outcome: the moved ids are `ok`,
 * every skipped id is looked up (already, conflict with its status, or
 * not_found). Ids must be valid uuids (see parseBulkIds).
 */
export async function bulkAction(ctx: ServiceContext, action: "approve" | "reject", ids: string[]): Promise<MessageActionResult[]> {
  const target = action === "approve" ? "approved" : "rejected";
  const out = action === "approve" ? await approveMessages(ctx, ids) : await rejectMessages(ctx, ids);
  const moved = new Set(action === "approve" ? (out as { approved: string[] }).approved : (out as { rejected: string[] }).rejected);
  const results: MessageActionResult[] = [];
  for (const id of ids) {
    results.push(moved.has(id) ? { kind: "ok", id, status: target } : await settle(ctx, id, target));
  }
  return results;
}

/** 1..BULK_MAX_IDS uuids, de-duplicated; null when the value is not that. */
export function parseBulkIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BULK_MAX_IDS) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isUuid(item)) return null;
    ids.push(item);
  }
  return [...new Set(ids)];
}

/** The rules of PATCH /v1/messages/:id; the error text when the input breaks them. */
export function editInputError(subject: unknown, markdown: unknown): string | null {
  if (subject === undefined && markdown === undefined) {
    return "Body must contain 'subject' and/or 'body_markdown'.";
  }
  if (subject !== undefined && (typeof subject !== "string" || subject.trim().length === 0 || subject.length > 300)) {
    return "'subject' must be a non-empty string of at most 300 characters.";
  }
  if (markdown !== undefined && (typeof markdown !== "string" || markdown.trim().length === 0 || markdown.length > 50_000)) {
    return "'body_markdown' must be a non-empty string of at most 50000 characters.";
  }
  return null;
}

/**
 * Edit subject and/or body of a pending_approval message (input checked
 * with editInputError first). The body is Markdown, rendered to HTML and
 * text like a drafted body; the drafted content is kept on the first edit.
 */
export async function editMessage(
  ctx: ServiceContext,
  id: string,
  input: { subject?: string; markdown?: string },
): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const store = storeFor(ctx.db).apiMessages;
  const current = await store.getMessageContent({ tenantId: ctx.tenant.id, messageId: id });
  if (!current) return { kind: "not_found", id };
  if (current.status !== "pending_approval") return { kind: "conflict", id, status: current.status };
  const edited = await store.editMessage({
    tenantId: ctx.tenant.id,
    messageId: id,
    subject: typeof input.subject === "string" ? input.subject.trim() : current.subject ?? "",
    bodyHtml: typeof input.markdown === "string" ? renderMarkdownToHtml(input.markdown) : current.bodyHtml ?? "",
    bodyText: typeof input.markdown === "string" ? markdownToText(input.markdown) : current.bodyText ?? "",
    actor: actorOf(ctx.tenant),
    now: new Date(),
  });
  if (!edited) return settle(ctx, id, null);
  return { kind: "ok", id, status: "pending_approval" };
}

export const ACTION_TYPE_RE = /^[a-z0-9_]{1,64}$/;

/** Longest reviewer instruction a revise accepts. */
export const REVISION_MAX_CHARS = 2000;

/**
 * pending_approval -> pending_generation for a new draft, then a generation
 * job. With actionType the brain drafts that action and skips decide. With
 * instruction (revise) the brain rewrites the current draft to apply the
 * reviewer's feedback; the instruction is kept in the message's revise
 * thread. The LLM runs later in the content worker, never here.
 */
export async function regenerateMessage(
  ctx: ServiceContext,
  id: string,
  actionType: string | null,
  instruction: string | null = null,
): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const now = new Date();
  const ok = await storeFor(ctx.db).apiMessages.regenerateMessage({
    tenantId: ctx.tenant.id,
    messageId: id,
    actionType,
    ...(instruction ? { revision: { instruction, by: actorOf(ctx.tenant), at: now.toISOString() } } : {}),
    now,
  });
  if (!ok) return settle(ctx, id, null);
  if (ctx.enqueue) {
    await ctx.enqueue(
      QUEUE.PROCESS_MESSAGE,
      { tenant_id: ctx.tenant.id, message_id: id },
      { singletonKey: id, retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
    ).catch(() => {});
  }
  return { kind: "ok", id, status: "pending_generation" };
}

/** approved -> cancelled (terminal). Already cancelled is `already`. */
export async function cancelMessage(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  if (await storeFor(ctx.db).apiMessages.cancelMessage({ tenantId: ctx.tenant.id, messageId: id, actor: actorOf(ctx.tenant), now: new Date() })) {
    return { kind: "ok", id, status: "cancelled" };
  }
  return settle(ctx, id, "cancelled");
}

/** value_gated -> pending_approval: a person reviews a draft the value gate held. */
export async function releaseValueGated(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const now = new Date();
  const batch = pendingApprovalBatch(now);
  const ok = await storeFor(ctx.db).apiMessages.releaseValueGated({
    tenantId: ctx.tenant.id,
    messageId: id,
    now,
    outbox: [{ event: "message.pending_approval", payload: { message_id: id }, dedupKey: batch.dedupKey, deliverAt: batch.deliverAt, batched: true }],
  });
  if (!ok) return settle(ctx, id, null);
  return { kind: "ok", id, status: "pending_approval" };
}

/** value_gated -> cancelled: the held draft is not wanted. */
export async function dismissValueGated(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  if (await storeFor(ctx.db).apiMessages.dismissValueGated({ tenantId: ctx.tenant.id, messageId: id, actor: actorOf(ctx.tenant), now: new Date() })) {
    return { kind: "ok", id, status: "cancelled" };
  }
  return settle(ctx, id, "cancelled");
}

/** approved -> pending_approval, with the batched message.pending_approval outbox entry. */
export async function unapproveMessage(ctx: ServiceContext, id: string): Promise<MessageActionResult> {
  if (!isUuid(id)) return { kind: "not_found", id };
  const now = new Date();
  const batch = pendingApprovalBatch(now);
  const ok = await storeFor(ctx.db).apiMessages.unapproveMessage({
    tenantId: ctx.tenant.id,
    messageId: id,
    now,
    outbox: [{ event: "message.pending_approval", payload: { message_id: id }, dedupKey: batch.dedupKey, deliverAt: batch.deliverAt, batched: true }],
  });
  if (!ok) return settle(ctx, id, null);
  return { kind: "ok", id, status: "pending_approval" };
}

// ---------------------------------------------------------------------------
// Reads: the queue as GET /v1/messages lists it
// ---------------------------------------------------------------------------

interface QueueCursor {
  created_at: string;
  id: string;
  /** 0 = critical-class flow, 1 = other (G20 order); absent in older cursors. */
  rank?: number;
}

function encodeQueueCursor(createdAt: Date | string | null | undefined, id: string, rank: number): string {
  const ts = createdAt instanceof Date ? createdAt.toISOString() : (createdAt ?? new Date(0).toISOString());
  const payload: QueueCursor = { created_at: ts, id, rank };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeQueueCursor(cursor: string): QueueCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) return null;
    return parsed as QueueCursor;
  } catch {
    return null;
  }
}

/**
 * One page of the product's messages in `status`: critical-class flows
 * first, then oldest first. An unreadable cursor starts from the first page.
 */
export async function listMessagesPage(
  ctx: Pick<ServiceContext, "db" | "tenant">,
  input: { status: string; limit: number; after?: string | null },
): Promise<{ rows: MessageListRow[]; next_cursor: string | null }> {
  const cursor = input.after ? decodeQueueCursor(input.after) : null;
  const rows = await storeFor(ctx.db).apiMessages.listMessages({
    tenantId: ctx.tenant.id,
    status: input.status,
    after: cursor ? { createdAt: cursor.created_at, id: cursor.id, rank: typeof cursor.rank === "number" ? cursor.rank : 1 } : null,
    limit: input.limit + 1,
  });
  const hasNextPage = rows.length > input.limit;
  const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    next_cursor: hasNextPage && lastRow
      ? encodeQueueCursor(lastRow.created_at, lastRow.id, lastRow.flow_class === "critical" ? 0 : 1)
      : null,
  };
}
