/**
 * Contract tests of the MCP endpoint (POST /v1/mcp), run on every backend:
 * mcp.db.test.ts (Postgres) and mcp-d1.test.ts (D1 in Miniflare).
 *
 * Fixtures are inserted with the backend's schema objects (same property
 * names on both) and explicit ids, so the same code seeds either database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../../src/http/ingest-auth.js";

export interface McpHarness {
  /** A built Claros app on this backend. */
  app: { fetch(req: Request): Response | Promise<Response> };
  /** Drizzle handle and the backend's schema module. */
  db: any;
  schema: any;
  /** Jobs the app enqueued (name and payload). */
  jobs: Array<{ name: string; data: Record<string, unknown> }>;
  /** Info log lines the app wrote. */
  logs: Array<Record<string, unknown>>;
}

/** A logger for buildApp that keeps info lines in `logs`. */
export function captureLogger(logs: Array<Record<string, unknown>>) {
  const none = () => {};
  return { debug: none, warn: none, error: none, info: (obj: unknown) => { if (obj && typeof obj === "object") logs.push(obj as Record<string, unknown>); } };
}

const URL_ = "http://localhost:3000/v1/mcp";

/** Label of every key these tests create, and the slug prefix of their products (for cleanup). */
export const MCP_TEST_LABEL = "mcp-contract-test";
export const MCP_TEST_SLUG_PREFIX = "mcp-";

export function mcpContract(name: string, open: () => Promise<McpHarness>): void {
  describe(`MCP endpoint on ${name}`, () => {
    let h: McpHarness;
    let s: any;

    beforeAll(async () => {
      h = await open();
      s = h.schema;
    }, 120_000);

    // ------------------------------------------------------------ fixtures

    async function product(opts: { archived?: boolean } = {}) {
      const id = randomUUID();
      const slug = `mcp-${id.slice(0, 8)}`;
      await h.db.insert(s.tenants).values({ id, name: `MCP ${slug}`, slug, ...(opts.archived ? { archivedAt: new Date() } : {}) });
      return { id, slug };
    }

    async function key(tenantId: string | null, kind: string, scopes: string[] | null, opts: { revoked?: boolean } = {}) {
      const prefix = { admin: "clr_ak_", secret: "clr_sk_", publishable: "clr_pk_", instance: "clr_ik_" }[kind]!;
      const raw = `${prefix}${randomBytes(24).toString("base64url")}`;
      const id = randomUUID();
      await h.db.insert(s.apiKeys).values({
        id,
        tenantId,
        keyHash: hashApiKey(raw),
        prefix: raw.slice(0, 8),
        label: MCP_TEST_LABEL,
        kind,
        scopes,
        ...(opts.revoked ? { revokedAt: new Date() } : {}),
      });
      return { raw, id };
    }

    const ALL = ["messages", "contacts:read", "config"];

    async function contact(tenantId: string, values: Record<string, unknown> = {}) {
      const id = randomUUID();
      await h.db.insert(s.contacts).values({
        id,
        tenantId,
        externalId: `u_${id.slice(0, 8)}`,
        email: `p-${id.slice(0, 8)}@example.com`,
        lifecycleState: "activated",
        ...values,
      });
      return id;
    }

    async function flow(tenantId: string, values: Record<string, unknown> = {}) {
      const id = randomUUID();
      await h.db.insert(s.flows).values({
        id,
        tenantId,
        name: "Trial ending",
        slug: `trial-${id.slice(0, 6)}`,
        triggerType: "event",
        triggerConfig: {},
        steps: [],
        status: "active",
        flowClass: "nurture",
        approvalMode: "require",
        compileStatus: "ready",
        compiledPlan: { steps: [{ order: 1 }] },
        ...values,
      });
      return id;
    }

    let order = 0;
    async function message(tenantId: string, values: Record<string, unknown> = {}, refs?: { contactId: string; flowId: string }) {
      const contactId = refs?.contactId ?? (await contact(tenantId));
      const flowId = refs?.flowId ?? (await flow(tenantId));
      const membershipId = randomUUID();
      // Completed, so one contact can have several messages of a flow (one active membership per flow).
      await h.db.insert(s.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, status: "completed", enteredAt: new Date() });
      const id = randomUUID();
      await h.db.insert(s.lifecycleMessages).values({
        id,
        tenantId,
        contactId,
        flowId,
        membershipId,
        flowStepOrder: ++order,
        status: "pending_approval",
        subject: "Your trial ends Friday",
        bodyText: "Hi Ann,\n\nyour trial ends on Friday. Keep your data by picking a plan.",
        bodyHtml: "<p>Hi Ann,</p><p>your trial ends on Friday.</p>",
        brainActionType: "trial_reminder",
        brainReasoning: "Trial ends in 3 days, no plan yet.",
        ...values,
      });
      return id;
    }

    async function row(id: string) {
      const [r] = await h.db.select().from(s.lifecycleMessages).where(eq(s.lifecycleMessages.id, id));
      return r;
    }

    // ------------------------------------------------------------ requests

    function post(body: unknown, headers: Record<string, string> = {}) {
      return h.app.fetch(new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }));
    }

    async function rpc(raw: string, method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) {
      const res = await post({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, { authorization: `Bearer ${raw}`, ...headers });
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    }

    async function call(raw: string, tool: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
      const body = await rpc(raw, "tools/call", { name: tool, arguments: args }, headers);
      if (body.error) return { error: body.error, result: null as any, isError: false };
      const result = body.result;
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      return { error: null, result: result.structuredContent, isError: result.isError === true };
    }

    // ---------------------------------------------------------------- auth

    it("answers 401 without a product admin key, whatever else is sent", async () => {
      const p = await product();
      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
      expect((await post(init)).status).toBe(401);
      const secret = await key(p.id, "secret", null);
      const instance = await key(null, "instance", ["instance:read", "products:write"]);
      const revoked = await key(p.id, "admin", ALL, { revoked: true });
      for (const raw of [secret.raw, instance.raw, revoked.raw, "clr_ak_unknown"]) {
        const res = await post(init, { authorization: `Bearer ${raw}` });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain("Bearer");
      }
    });

    it("does not accept a dashboard session cookie", async () => {
      const p = await product();
      const userId = randomUUID();
      await h.db.insert(s.users).values({ id: userId, tenantId: p.id, email: `o-${p.slug}@example.com`, role: "owner" });
      const sessionId = randomUUID();
      await h.db.insert(s.sessions).values({ id: sessionId, tenantId: p.id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
      const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { cookie: `claros_session=${sessionId}` });
      expect(res.status).toBe(401);
    });

    it("refuses other origins, GET and DELETE, and malformed bodies", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ALL);
      const auth = { authorization: `Bearer ${k.raw}` };
      expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ...auth, origin: "https://evil.example" })).status).toBe(403);
      expect((await h.app.fetch(new Request(URL_, { method: "GET", headers: auth }))).status).toBe(405);
      expect((await h.app.fetch(new Request(URL_, { method: "DELETE", headers: auth }))).status).toBe(405);
      const parse = await post("{nope", auth);
      expect(parse.status).toBe(400);
      expect(((await parse.json()) as any).error.code).toBe(-32700);
      const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }], auth);
      expect(((await batch.json()) as any).error.code).toBe(-32600);
      expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ...auth, "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
    });

    // ----------------------------------------------------------- handshake

    it("initializes, accepts the initialized notification and answers ping", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const init = await rpc(k.raw, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(init.result.protocolVersion).toBe("2025-06-18");
      expect(init.result.capabilities.tools).toBeDefined();
      expect(init.result.serverInfo.name).toBe("claros");
      expect(typeof init.result.instructions).toBe("string");
      const newer = await rpc(k.raw, "initialize", { protocolVersion: "2099-01-01", capabilities: {} });
      expect(newer.result.protocolVersion).toBe("2025-11-25");
      const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: `Bearer ${k.raw}` });
      expect(note.status).toBe(202);
      expect((await rpc(k.raw, "ping")).result).toEqual({});
      expect((await rpc(k.raw, "resources/list")).error.code).toBe(-32601);
    });

    // -------------------------------------------------------------- scopes

    it("lists only the tools the key's scopes allow, with JSON Schema inputs", async () => {
      const p = await product();
      const names = async (scopes: string[]) => {
        const k = await key(p.id, "admin", scopes);
        const r = await rpc(k.raw, "tools/list");
        return (r.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
      };
      expect(await names(["messages"])).toEqual([
        "approve_messages", "cancel_message", "edit_message", "exclude_contact", "get_message",
        "list_pending_approvals", "queue_summary", "regenerate_message", "reject_messages", "unapprove_message",
      ]);
      expect(await names(["contacts:read"])).toEqual(["get_contact", "get_contact_timeline"]);
      expect(await names(["config"])).toEqual(["list_flows", "pause_flow", "resume_flow"]);
      expect(await names(["kb", "suppressions"])).toEqual([]);
      const k = await key(p.id, "admin", ALL);
      const tools = (await rpc(k.raw, "tools/list")).result.tools as any[];
      expect(tools).toHaveLength(15);
      const approve = tools.find((t) => t.name === "approve_messages");
      expect(approve.inputSchema.type).toBe("object");
      expect(approve.inputSchema.required).toEqual(["ids"]);
      expect(approve.annotations.readOnlyHint).toBe(false);
      expect(tools.find((t) => t.name === "reject_messages").annotations.destructiveHint).toBe(true);
      expect(tools.find((t) => t.name === "get_message").annotations.readOnlyHint).toBe(true);
    });

    it("re-checks the scope on tools/call and changes nothing", async () => {
      const p = await product();
      const m = await message(p.id);
      const k = await key(p.id, "admin", ["contacts:read"]);
      const r = await call(k.raw, "approve_messages", { ids: [m] });
      expect(r.error.code).toBe(-32003);
      expect(r.error.message).toContain("'messages'");
      expect((await row(m)).status).toBe("pending_approval");
      const unknown = await call(k.raw, "send_email", {});
      expect(unknown.error.code).toBe(-32602);
    });

    // ---------------------------------------------------------------- reads

    it("queue_summary counts open messages of the key's product only", async () => {
      const p = await product();
      const other = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const critical = await flow(p.id, { flowClass: "critical" });
      const c = await contact(p.id);
      const old = new Date(Date.now() - 3 * 86_400_000);
      await message(p.id, { createdAt: old }, { contactId: c, flowId: critical });
      await message(p.id);
      await message(p.id, { status: "approved" });
      await message(p.id, { status: "pending_generation", statusReason: "llm_budget" });
      await message(p.id, { status: "value_gated" });
      await message(p.id, { status: "failed", brainReasoning: "generation_failed: no provider" });
      await message(p.id, { status: "sent" });
      await message(other.id);
      const r = await call(k.raw, "queue_summary");
      expect(r.result).toMatchObject({
        product: p.slug,
        pending_approval: 2,
        critical_pending: 1,
        approved_not_sent: 1,
        waiting_for_draft: 0,
        waiting_for_llm_budget: 1,
        value_gated_last_7_days: 1,
        failed_generation_last_7_days: 1,
      });
      expect(new Date(r.result.oldest_pending_at).getTime()).toBe(old.getTime());
    });

    it("list_pending_approvals puts critical first, previews the body and pages", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const critical = await flow(p.id, { flowClass: "critical", name: "Dunning" });
      const base = Date.now() - 60_000;
      const a = await message(p.id, { createdAt: new Date(base), bodyText: "x".repeat(400) });
      const b = await message(p.id, { createdAt: new Date(base + 1000) });
      const crit = await message(p.id, { createdAt: new Date(base + 2000) }, { contactId: await contact(p.id), flowId: critical });
      await message(p.id, { status: "approved" });
      const first = await call(k.raw, "list_pending_approvals", { limit: 2 });
      expect(first.result.messages.map((m: any) => m.id)).toEqual([crit, a]);
      expect(first.result.messages[0].flow).toEqual({ name: "Dunning", class: "critical" });
      expect(first.result.messages[1].preview.length).toBe(280);
      expect(first.result.messages[0].contact.email).toMatch(/@example\.com$/);
      expect(first.result.messages[0].reasoning).toBe("Trial ends in 3 days, no plan yet.");
      expect(first.result.next_cursor).toBeTruthy();
      const second = await call(k.raw, "list_pending_approvals", { limit: 2, cursor: first.result.next_cursor });
      expect(second.result.messages.map((m: any) => m.id)).toEqual([b]);
      expect(second.result.next_cursor).toBeNull();
      const bad = await call(k.raw, "list_pending_approvals", { limit: 500 });
      expect(bad.isError).toBe(true);
      expect(bad.result.error).toContain("limit");
    });

    it("get_message returns the message in full, and not_found across products", async () => {
      const p = await product();
      const other = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const m = await message(p.id, { editedBy: "user:u1", editedAt: new Date(), originalSubject: "Drafted subject", originalBodyText: "Drafted body" });
      const r = await call(k.raw, "get_message", { id: m });
      expect(r.isError).toBe(false);
      expect(r.result).toMatchObject({
        id: m,
        status: "pending_approval",
        subject: "Your trial ends Friday",
        action_type: "trial_reminder",
        edited_by: "user:u1",
        original: { subject: "Drafted subject", body_text: "Drafted body" },
        flow: { name: "Trial ending", class: "nurture" },
      });
      expect(r.result.body_text).toContain("your trial ends on Friday");
      const foreign = await message(other.id);
      const miss = await call(k.raw, "get_message", { id: foreign });
      expect(miss.isError).toBe(true);
      expect(miss.result.error).toContain("No such message");
    });

    it("get_contact finds a contact by id, external_id or email; get_contact_timeline pages", async () => {
      const p = await product();
      const other = await product();
      const k = await key(p.id, "admin", ["contacts:read"]);
      const id = await contact(p.id, { externalId: "u_42", email: "Ann@Example.com", name: "Ann", properties: { plan: "trial" } });
      const f = await flow(p.id);
      await message(p.id, { status: "sent", sentAt: new Date() }, { contactId: id, flowId: f });
      await message(p.id, { status: "sent", sentAt: new Date() }, { contactId: id, flowId: f });
      for (const args of [{ id }, { external_id: "u_42" }, { email: "ann@example.com" }]) {
        const r = await call(k.raw, "get_contact", args);
        expect(r.isError).toBe(false);
        expect(r.result.contact.id).toBe(id);
        expect(r.result.contact.external_id).toBe("u_42");
        expect(r.result.memberships.length).toBe(2);
        expect(Array.isArray(r.result.topics)).toBe(true);
      }
      expect((await call(k.raw, "get_contact", { id, email: "ann@example.com" })).isError).toBe(true);
      await contact(other.id, { externalId: "u_77" });
      expect((await call(k.raw, "get_contact", { external_id: "u_77" })).result.error).toContain("No such contact");
      const t1 = await call(k.raw, "get_contact_timeline", { contact: "u_42", limit: 1 });
      expect(t1.result.items).toHaveLength(1);
      expect(t1.result.items[0].kind).toBe("message");
      const t2 = await call(k.raw, "get_contact_timeline", { contact: id, limit: 1, cursor: t1.result.next_cursor });
      expect(t2.result.items).toHaveLength(1);
      expect(t2.result.items[0].id).not.toBe(t1.result.items[0].id);
    });

    it("list_flows shows each flow with what waits in it", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["config"]);
      const f = await flow(p.id, { name: "Dunning", flowClass: "critical" });
      const c = await contact(p.id);
      await message(p.id, {}, { contactId: c, flowId: f });
      await message(p.id, { status: "approved" }, { contactId: c, flowId: f });
      await flow(p.id, { name: "Old", status: "archived" });
      const r = await call(k.raw, "list_flows");
      expect(r.result.flows).toHaveLength(1);
      expect(r.result.flows[0]).toMatchObject({ id: f, name: "Dunning", status: "active", flow_class: "critical", approval_mode: "require", pending_approval: 1, approved_not_sent: 1 });
      expect((await call(k.raw, "list_flows", { include_archived: true })).result.flows).toHaveLength(2);
    });

    // --------------------------------------------------------------- writes

    it("approve_messages approves, records the key, enqueues the drain, and reports a mix of outcomes", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const pending = await message(p.id);
      const already = await message(p.id, { status: "approved" });
      const sent = await message(p.id, { status: "sent" });
      const missing = randomUUID();
      h.jobs.length = 0;
      const r = await call(k.raw, "approve_messages", { ids: [pending, already, sent, missing] });
      expect(r.isError).toBe(false);
      expect(r.result.approved).toBe(1);
      expect(r.result.results).toEqual([
        { id: pending, outcome: "done", status: "approved" },
        { id: already, outcome: "unchanged", status: "approved" },
        expect.objectContaining({ id: sent, outcome: "conflict", status: "sent" }),
        expect.objectContaining({ id: missing, outcome: "not_found" }),
      ]);
      const after = await row(pending);
      expect(after.status).toBe("approved");
      expect(after.approvedBy).toBe(`api_key:${k.id}`);
      expect(h.jobs.filter((j) => j.data.message_id === pending)).toHaveLength(1);
      expect((await row(sent)).status).toBe("sent");
    });

    it("reject_messages rejects; a message that moved on is a conflict with its status", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const pending = await message(p.id);
      const approved = await message(p.id, { status: "approved" });
      const r = await call(k.raw, "reject_messages", { ids: [pending, approved] });
      expect(r.result.results[0]).toEqual({ id: pending, outcome: "done", status: "rejected" });
      expect(r.result.results[1]).toMatchObject({ id: approved, outcome: "conflict", status: "approved" });
      expect((await row(pending)).rejectedBy).toBe(`api_key:${k.id}`);
      expect((await row(approved)).status).toBe("approved");
    });

    it("edit_message edits a pending draft and keeps the drafted content", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const m = await message(p.id);
      const r = await call(k.raw, "edit_message", { id: m, subject: "New subject", body_markdown: "Hello **Ann**" });
      expect(r.result).toEqual({ id: m, outcome: "done", status: "pending_approval" });
      const after = await row(m);
      expect(after.subject).toBe("New subject");
      expect(after.bodyHtml).toContain("<strong>Ann</strong>");
      expect(after.originalSubject).toBe("Your trial ends Friday");
      expect(after.editedBy).toBe(`api_key:${k.id}`);
      expect((await call(k.raw, "edit_message", { id: m })).isError).toBe(true);
      const sent = await message(p.id, { status: "sent" });
      const conflict = await call(k.raw, "edit_message", { id: sent, subject: "x" });
      expect(conflict.isError).toBe(true);
      expect(conflict.result).toMatchObject({ outcome: "conflict", status: "sent" });
    });

    it("regenerate, cancel and unapprove move messages like the routes do", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const m = await message(p.id);
      h.jobs.length = 0;
      const regen = await call(k.raw, "regenerate_message", { id: m, action_type: "tip_trick" });
      expect(regen.result).toMatchObject({ outcome: "done", status: "pending_generation", forced_action_type: "tip_trick" });
      expect((await row(m)).forcedActionType).toBe("tip_trick");
      expect(h.jobs.some((j) => j.data.message_id === m)).toBe(true);
      expect((await call(k.raw, "regenerate_message", { id: m, action_type: "Bad Type" })).isError).toBe(true);

      const a = await message(p.id, { status: "approved" });
      expect((await call(k.raw, "unapprove_message", { id: a })).result).toEqual({ id: a, outcome: "done", status: "pending_approval" });
      expect((await row(a)).status).toBe("pending_approval");

      const b = await message(p.id, { status: "approved" });
      expect((await call(k.raw, "cancel_message", { id: b })).result).toEqual({ id: b, outcome: "done", status: "cancelled" });
      expect((await call(k.raw, "cancel_message", { id: b })).result).toEqual({ id: b, outcome: "unchanged", status: "cancelled" });
      const pending = await message(p.id);
      const conflict = await call(k.raw, "cancel_message", { id: pending });
      expect(conflict.isError).toBe(true);
      expect(conflict.result).toMatchObject({ outcome: "conflict", status: "pending_approval" });
    });

    it("exclude_contact suppresses the address and cancels unsent mail", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const c = await contact(p.id, { externalId: "u_9", email: "nine@example.com" });
      const f = await flow(p.id);
      const m1 = await message(p.id, {}, { contactId: c, flowId: f });
      const m2 = await message(p.id, { status: "approved" }, { contactId: c, flowId: f });
      const r = await call(k.raw, "exclude_contact", { contact: "u_9" });
      expect(r.result).toMatchObject({ id: c, external_id: "u_9", suppressed: true });
      expect([...r.result.cancelled].sort()).toEqual([m1, m2].sort());
      expect((await row(m1)).status).toBe("cancelled");
      const [sup] = await h.db.select().from(s.suppressions).where(eq(s.suppressions.tenantId, p.id));
      expect(sup.email).toBe("nine@example.com");
    });

    it("pause_flow and resume_flow follow the flow status rules", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["config"]);
      const f = await flow(p.id, { slug: "dunning" });
      expect((await call(k.raw, "pause_flow", { flow: "dunning" })).result).toMatchObject({ id: f, status: "paused", outcome: "done" });
      expect((await call(k.raw, "pause_flow", { flow: f })).result).toMatchObject({ status: "paused", outcome: "unchanged" });
      expect((await call(k.raw, "resume_flow", { flow: "dunning" })).result).toMatchObject({ status: "active", outcome: "done" });
      const draft = await flow(p.id, { status: "draft", slug: "drafty" });
      const bad = await call(k.raw, "pause_flow", { flow: draft });
      expect(bad.isError).toBe(true);
      expect((await call(k.raw, "pause_flow", { flow: "nope" })).result.error).toContain("No such flow");
    });

    it("logs one line per call with tool, product, key and outcome, never the arguments", async () => {
      const p = await product();
      const k = await key(p.id, "admin", ["messages"]);
      const m = await message(p.id);
      h.logs.length = 0;
      await call(k.raw, "edit_message", { id: m, subject: "Secret subject", body_markdown: "secret-body ann@example.com" });
      const lines = h.logs.filter((l) => l.event === "mcp_call");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ mcp_method: "tools/call", tool: "edit_message", product: p.slug, key_id: k.id, outcome: "ok", status: 200 });
      expect(typeof lines[0]!.duration_ms).toBe("number");
      const text = JSON.stringify(h.logs);
      expect(text).not.toContain("Secret subject");
      expect(text).not.toContain("ann@example.com");
      expect(text).not.toContain(k.raw);
    });

    // ----------------------------------------------------------- isolation

    it("a key of product A never reads or acts on product B, whatever header is sent", async () => {
      const a = await product();
      const b = await product();
      const k = await key(a.id, "admin", ALL);
      const mb = await message(b.id);
      const cb = await contact(b.id, { externalId: "u_b" });
      const fb = await flow(b.id, { slug: "b-flow" });
      const headers = { "x-claros-product": b.slug };
      expect((await call(k.raw, "approve_messages", { ids: [mb] }, headers)).result.results[0].outcome).toBe("not_found");
      expect((await call(k.raw, "reject_messages", { ids: [mb] }, headers)).result.results[0].outcome).toBe("not_found");
      expect((await call(k.raw, "edit_message", { id: mb, subject: "x" }, headers)).result.outcome).toBe("not_found");
      expect((await call(k.raw, "cancel_message", { id: mb }, headers)).result.outcome).toBe("not_found");
      expect((await call(k.raw, "get_message", { id: mb }, headers)).isError).toBe(true);
      expect((await call(k.raw, "get_contact", { id: cb }, headers)).isError).toBe(true);
      expect((await call(k.raw, "exclude_contact", { contact: "u_b" }, headers)).isError).toBe(true);
      expect((await call(k.raw, "pause_flow", { flow: fb }, headers)).isError).toBe(true);
      expect((await call(k.raw, "queue_summary", {}, headers)).result.pending_approval).toBe(0);
      expect((await call(k.raw, "list_pending_approvals", {}, headers)).result.messages).toEqual([]);
      expect((await row(mb)).status).toBe("pending_approval");
      const [flowRow] = await h.db.select().from(s.flows).where(eq(s.flows.id, fb));
      expect(flowRow.status).toBe("active");
    });

    it("an archived product reads but refuses write tools", async () => {
      const p = await product({ archived: true });
      const k = await key(p.id, "admin", ["messages"]);
      const m = await message(p.id);
      expect((await call(k.raw, "list_pending_approvals")).result.messages).toHaveLength(1);
      const r = await call(k.raw, "approve_messages", { ids: [m] });
      expect(r.isError).toBe(true);
      expect(r.result.error).toContain("archived");
      expect((await row(m)).status).toBe("pending_approval");
    });
  });
}
