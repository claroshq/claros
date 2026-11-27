/**
 * MCP tools: an operator works a product's approval queue and looks up
 * contacts and flows from an MCP client (Claude Code, Claude Desktop).
 *
 * Every tool maps onto an existing admin key scope and calls the same
 * service and store functions as the HTTP routes (services/*), so every
 * transition stays the store's compare-and-swap. A message that already
 * moved on comes back as a tool result with its current status, not as a
 * protocol error. No tool sends mail, calls the LLM, or changes config:
 * approving lands a message in `approved` and the normal drain (send
 * window, throttle, suppression) sends it, exactly as from the dashboard.
 *
 * Input schemas use the `zod/v4` subpath of the installed zod (3.25+), for
 * its JSON Schema export; the rest of the API stays on zod 3.
 */
import { z } from "zod/v4";
import { storeFor, type MessageListRow, type OpenMessageCount } from "@claros/store";
import type { AdminScope } from "../http/admin-auth.js";
import {
  ACTION_TYPE_RE,
  BULK_MAX_IDS,
  bulkAction,
  cancelMessage,
  editInputError,
  editMessage,
  isUuid,
  listMessagesPage,
  regenerateMessage,
  unapproveMessage,
  type MessageActionResult,
  type ServiceContext,
} from "../services/messages.js";
import { contactTimelinePage, excludeContact, findContact, getContactDetail } from "../services/contacts.js";
import { setFlowStatus } from "../services/flows.js";

/** What a tool returns: a JSON body for the model, and whether it is an error result. */
export interface ToolOutput {
  body: Record<string, unknown>;
  isError?: boolean;
  /** Short outcome for the log line (never arguments or content). */
  outcome: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: AdminScope;
  /** Changes data (blocked on archived products). */
  write: boolean;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
  input: z.ZodObject<z.ZodRawShape>;
  run(ctx: ServiceContext, args: Record<string, unknown>): Promise<ToolOutput>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PREVIEW_CHARS = 280;
/** value_gated and failed generations are counted over this window. */
const RECENT_DAYS = 7;

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a message id (uuid)");
const LIMIT = z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Items per page, default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}`);
const CURSOR = z.string().max(500).optional().describe("next_cursor from the previous page");
const CONTACT_REF = z.string().min(1).max(255).describe("The contact's id (uuid) or your user id (external_id)");

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

function preview(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 3)}...` : flat;
}

function queueItem(r: MessageListRow) {
  return {
    id: r.id,
    created_at: iso(r.created_at),
    flow: { name: r.flow_name ?? null, class: r.flow_class ?? null },
    step: r.flow_step_order,
    action_type: r.brain_action_type,
    subject: r.subject,
    preview: preview(r.body_text),
    reasoning: r.brain_reasoning,
    status_reason: r.status_reason ?? null,
    contact: { email: r.contact_email, name: r.contact_name, external_id: r.contact_external_id },
  };
}

/** One message's outcome as the model sees it. */
function outcomeJson(r: MessageActionResult) {
  if (r.kind === "not_found") return { id: r.id, outcome: "not_found", message: "No such message in this product." };
  if (r.kind === "conflict") {
    return { id: r.id, outcome: "conflict", status: r.status, message: `The message is '${r.status}' now; it already moved on, nothing was changed.` };
  }
  return { id: r.id, outcome: r.kind === "ok" ? "done" : "unchanged", status: r.status };
}

/** A single-message action as a tool output: conflict and not found are error results. */
function single(r: MessageActionResult, extra: Record<string, unknown> = {}): ToolOutput {
  const body = { ...outcomeJson(r), ...(r.kind === "ok" ? extra : {}) };
  const failed = r.kind === "conflict" || r.kind === "not_found";
  return { body, isError: failed || undefined, outcome: r.kind };
}

function fail(message: string, outcome = "invalid"): ToolOutput {
  return { body: { error: message }, isError: true, outcome };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;

export const TOOLS: ToolDef[] = [
  // ---------------------------------------------------------------- reads
  {
    name: "queue_summary",
    title: "Queue summary",
    description:
      "Counts for the product's messages that are not final yet, in one call: drafts waiting for approval (critical-class ones separately, and the oldest), approved but not sent yet, waiting for a draft, waiting for the daily LLM budget, and over the last 7 days drafts held back by the value gate and drafts whose generation failed.",
    scope: "messages",
    write: false,
    annotations: READ,
    input: z.object({}),
    async run(ctx) {
      const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
      const rows = await storeFor(ctx.db).apiMessages.countOpenMessages({ tenantId: ctx.tenant.id, since });
      const sum = (f: (r: OpenMessageCount) => boolean) => rows.filter(f).reduce((n, r) => n + r.n, 0);
      const pending = rows.filter((r) => r.status === "pending_approval");
      const oldest = pending.map((r) => r.oldest_created_at?.getTime() ?? Infinity).reduce((a, b) => Math.min(a, b), Infinity);
      return {
        outcome: "ok",
        body: {
          product: ctx.tenant.slug,
          pending_approval: sum((r) => r.status === "pending_approval"),
          critical_pending: sum((r) => r.status === "pending_approval" && r.flow_class === "critical"),
          oldest_pending_at: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
          approved_not_sent: sum((r) => r.status === "approved"),
          waiting_for_draft: sum((r) => r.status === "pending_generation" && r.reason !== "llm_budget"),
          waiting_for_llm_budget: sum((r) => r.status === "pending_generation" && r.reason === "llm_budget"),
          value_gated_last_7_days: sum((r) => r.status === "value_gated"),
          failed_generation_last_7_days: sum((r) => r.status === "failed"),
        },
      };
    },
  },
  {
    name: "list_pending_approvals",
    title: "List drafts waiting for approval",
    description:
      "The approval queue: drafts waiting for a decision, critical-class flows first, then oldest first. Each item has the flow and its class, the action type, subject, a short preview of the body, the brain's reasoning, and the contact. Use get_message for the full body. Pass next_cursor for the next page.",
    scope: "messages",
    write: false,
    annotations: READ,
    input: z.object({ limit: LIMIT, cursor: CURSOR }),
    async run(ctx, a) {
      const page = await listMessagesPage(ctx, {
        status: "pending_approval",
        limit: (a.limit as number | undefined) ?? DEFAULT_LIMIT,
        after: a.cursor as string | undefined,
      });
      return { outcome: "ok", body: { messages: page.rows.map(queueItem), next_cursor: page.next_cursor } };
    },
  },
  {
    name: "get_message",
    title: "Get a message",
    description:
      "One message in full: status, subject, the body as text, the AI opening line, the brain's reasoning and choice, the content as drafted when someone edited it, and the last approval, rejection (or cancellation) and edit with who did it ('user:<id>' or 'api_key:<id>').",
    scope: "messages",
    write: false,
    annotations: READ,
    input: z.object({ id: UUID }),
    async run(ctx, a) {
      const r = await storeFor(ctx.db).apiMessages.getMessage({ tenantId: ctx.tenant.id, messageId: a.id as string });
      if (!r) return fail("No such message in this product.", "not_found");
      return {
        outcome: "ok",
        body: {
          id: r.id,
          status: r.status,
          status_reason: r.status_reason ?? null,
          created_at: iso(r.created_at),
          scheduled_send_at: iso(r.scheduled_send_at),
          flow: { id: r.flow_id, name: r.flow_name ?? null, class: r.flow_class ?? null },
          step: r.flow_step_order,
          action_type: r.brain_action_type,
          forced_action_type: r.forced_action_type ?? null,
          subject: r.subject,
          body_text: r.body_text,
          opening_line: r.opening_line ?? null,
          reasoning: r.brain_reasoning,
          choose: r.choose_decision ?? null,
          original: r.edited_at ? { subject: r.original_subject ?? null, body_text: r.original_body_text ?? null } : null,
          approved_by: r.approved_by ?? null,
          approved_at: iso(r.approved_at),
          rejected_by: r.rejected_by ?? null,
          edited_by: r.edited_by ?? null,
          edited_at: iso(r.edited_at),
          imported: r.imported === true,
          contact: { id: r.contact_id, email: r.contact_email, name: r.contact_name, external_id: r.contact_external_id },
        },
      };
    },
  },
  {
    name: "get_contact",
    title: "Get a contact",
    description:
      "One contact by id, external_id (your user id) or email: profile and traits, lifecycle state, whether the address is suppressed, topic subscriptions, and the flows the contact is in.",
    scope: "contacts:read",
    write: false,
    annotations: READ,
    input: z.object({
      id: z.string().max(64).optional().describe("Contact id (uuid)"),
      external_id: z.string().max(255).optional().describe("Your user id for the contact"),
      email: z.string().max(320).optional().describe("Email address (exact, case ignored)"),
    }),
    async run(ctx, a) {
      const given = (["id", "external_id", "email"] as const).filter((k) => typeof a[k] === "string" && (a[k] as string).length > 0);
      if (given.length !== 1) return fail("Give exactly one of id, external_id or email.");
      const key = given[0]!;
      const value = (a[key] as string).trim();
      let contactId: string | null;
      if (key === "id") {
        contactId = isUuid(value) ? value.toLowerCase() : null;
      } else if (key === "email") {
        contactId = (await storeFor(ctx.db).apiContacts.findContactByEmail({ tenantId: ctx.tenant.id, email: value }))?.id ?? null;
      } else {
        contactId = (await storeFor(ctx.db).apiContacts.findContactByRef({ tenantId: ctx.tenant.id, ref: value }))?.id ?? null;
      }
      const detail = contactId ? await getContactDetail(ctx, contactId) : null;
      if (!detail) return fail("No such contact in this product.", "not_found");
      return { outcome: "ok", body: detail as unknown as Record<string, unknown> };
    },
  },
  {
    name: "get_contact_timeline",
    title: "Get a contact's timeline",
    description:
      "A contact's history, newest first: events your product sent, lifecycle state changes and messages (with status and opens or clicks). Pass next_cursor for older items.",
    scope: "contacts:read",
    write: false,
    annotations: READ,
    input: z.object({ contact: CONTACT_REF, limit: LIMIT, cursor: CURSOR }),
    async run(ctx, a) {
      const ref = await findContact(ctx, a.contact as string);
      if (!ref) return fail("No such contact in this product.", "not_found");
      const page = await contactTimelinePage(ctx, ref.id, (a.limit as number | undefined) ?? DEFAULT_LIMIT, a.cursor as string | undefined);
      // Request context (IP, user agent) stays out of the chat.
      const items = page.items.map(({ context: _context, ...item }) => item);
      return { outcome: "ok", body: { contact_id: ref.id, items, next_cursor: page.next_cursor } };
    },
  },
  {
    name: "list_flows",
    title: "List flows",
    description:
      "The product's flows with status, class (critical or nurture), approval mode and content mode, and how many of each flow's messages wait for approval or are approved but not sent yet.",
    scope: "config",
    write: false,
    annotations: READ,
    input: z.object({ include_archived: z.boolean().optional().describe("Include archived flows") }),
    async run(ctx, a) {
      const store = storeFor(ctx.db);
      const [flows, counts] = await Promise.all([
        store.apiFlows.listFlows({ tenantId: ctx.tenant.id, includeArchived: a.include_archived === true }),
        store.apiMessages.countOpenMessages({ tenantId: ctx.tenant.id, since: new Date() }),
      ]);
      const count = (flowId: string, status: string) =>
        counts.filter((r) => r.flow_id === flowId && r.status === status).reduce((n, r) => n + r.n, 0);
      return {
        outcome: "ok",
        body: {
          flows: flows.map((f) => ({
            id: f.id,
            slug: f.slug ?? null,
            name: f.name,
            status: f.status,
            flow_class: f.flowClass,
            approval_mode: f.approvalMode,
            content_mode: f.contentMode ?? "ai_drafted",
            compile_status: f.compileStatus,
            pending_approval: count(f.id, "pending_approval"),
            approved_not_sent: count(f.id, "approved"),
          })),
        },
      };
    },
  },

  // --------------------------------------------------------------- writes
  {
    name: "approve_messages",
    title: "Approve drafts",
    description:
      `Approve one or more drafts waiting for approval (up to ${BULK_MAX_IDS} ids). Approved messages go out through the normal send path: send window, throttle and suppression still apply, nothing is sent sooner than from the dashboard. Each id's outcome is returned: done, unchanged (already approved), conflict (it moved on; its current status is given) or not_found.`,
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.object({ ids: z.array(UUID).min(1).max(BULK_MAX_IDS).describe("Message ids") }),
    async run(ctx, a) {
      const ids = [...new Set(a.ids as string[])];
      const results = await bulkAction(ctx, "approve", ids);
      const done = results.filter((r) => r.kind === "ok").length;
      return { outcome: `approved:${done}/${ids.length}`, body: { results: results.map(outcomeJson), approved: done } };
    },
  },
  {
    name: "reject_messages",
    title: "Reject drafts",
    description:
      `Reject one or more drafts waiting for approval (up to ${BULK_MAX_IDS} ids). Rejection is final: the message is never sent. Each id's outcome is returned: done, unchanged (already rejected), conflict (it moved on; its current status is given) or not_found.`,
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: z.object({ ids: z.array(UUID).min(1).max(BULK_MAX_IDS).describe("Message ids") }),
    async run(ctx, a) {
      const ids = [...new Set(a.ids as string[])];
      const results = await bulkAction(ctx, "reject", ids);
      const done = results.filter((r) => r.kind === "ok").length;
      return { outcome: `rejected:${done}/${ids.length}`, body: { results: results.map(outcomeJson), rejected: done } };
    },
  },
  {
    name: "edit_message",
    title: "Edit a draft",
    description:
      "Change the subject and/or the body of a draft waiting for approval. The body is Markdown and replaces the whole body; it is rendered like a drafted body. The content as drafted is kept. The draft stays in the queue: approve it afterwards.",
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.object({
      id: UUID,
      subject: z.string().optional().describe("New subject, at most 300 characters"),
      body_markdown: z.string().optional().describe("New body in Markdown, at most 50000 characters"),
    }),
    async run(ctx, a) {
      const invalid = editInputError(a.subject, a.body_markdown);
      if (invalid) return fail(invalid);
      return single(await editMessage(ctx, a.id as string, { subject: a.subject as string | undefined, markdown: a.body_markdown as string | undefined }));
    },
  },
  {
    name: "regenerate_message",
    title: "Ask for a new draft",
    description:
      "Send a draft waiting for approval back for a new draft. With action_type, the new draft is for that action (the brain skips its own choice). The new draft is written later by the content worker and comes back to the queue; this call does not wait for it.",
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    input: z.object({
      id: UUID,
      action_type: z.string().regex(ACTION_TYPE_RE, "must match [a-z0-9_]{1,64}").optional().describe("Action to draft instead, for example tip_trick"),
    }),
    async run(ctx, a) {
      const actionType = (a.action_type as string | undefined) ?? null;
      return single(await regenerateMessage(ctx, a.id as string, actionType), { forced_action_type: actionType });
    },
  },
  {
    name: "cancel_message",
    title: "Cancel an approved message",
    description: "Cancel an approved message that has not been sent yet. Final: it is never sent.",
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: z.object({ id: UUID }),
    async run(ctx, a) {
      return single(await cancelMessage(ctx, a.id as string));
    },
  },
  {
    name: "unapprove_message",
    title: "Back to review",
    description: "Move an approved message that has not been sent yet back to the approval queue.",
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    input: z.object({ id: UUID }),
    async run(ctx, a) {
      return single(await unapproveMessage(ctx, a.id as string));
    },
  },
  {
    name: "exclude_contact",
    title: "Exclude a person from mail",
    description:
      "Stop all lifecycle mail to a person: adds a manual suppression of their address and cancels every message to them that has not been sent yet. Cancelled messages stay cancelled; the suppression can be removed later in the dashboard or the API.",
    scope: "messages",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: z.object({ contact: CONTACT_REF }),
    async run(ctx, a) {
      const out = await excludeContact(ctx, a.contact as string);
      if (!out) return fail("No such contact in this product.", "not_found");
      return { outcome: `excluded:${out.cancelled.length}`, body: out };
    },
  },
  ...(["pause", "resume"] as const).map((action): ToolDef => ({
    name: `${action}_flow`,
    title: action === "pause" ? "Pause a flow" : "Resume a flow",
    description:
      action === "pause"
        ? "Pause an active flow by id or slug: it stops enrolling and advancing contacts until resumed."
        : "Resume a paused flow by id or slug. It needs a compiled plan.",
    scope: "config",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.object({ flow: z.string().min(1).max(200).describe("Flow id or slug") }),
    async run(ctx, a) {
      const r = await setFlowStatus(ctx, a.flow as string, action === "pause" ? "paused" : "active");
      if (r.kind === "not_found") return fail("No such flow in this product.", "not_found");
      if (r.kind === "invalid") return fail(r.error, "invalid");
      if (r.kind === "conflict") return fail("The flow's status changed at the same time. Try again.", "conflict");
      return {
        outcome: r.kind,
        body: { id: r.flow.id, slug: r.flow.slug ?? null, name: r.flow.name, status: r.flow.status, outcome: r.kind === "ok" ? "done" : "unchanged" },
      };
    },
  })),
];

/** The tools a key with these scopes may see and call. */
export function toolsFor(scopes: readonly string[]): ToolDef[] {
  return TOOLS.filter((t) => scopes.includes(t.scope));
}

export function toolJson(t: ToolDef) {
  const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { name: t.name, title: t.title, description: t.description, inputSchema, annotations: { title: t.title, ...t.annotations } };
}
