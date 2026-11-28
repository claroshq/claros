/**
 * G20 approval actions and G14 reachability over HTTP: edit, regenerate
 * (forced action), cancel, unapprove, exclude, stale 409s, critical first,
 * admin-key approve/reject, approved_by/rejected_by, and the batched
 * pending_approval outbox row. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { lifecycleMessages, suppressions, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import { buildApp } from "../src/index.js";
import { openDb, newProduct, newKey, bearer, cookieJson, newMessage, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];

async function app() {
  return buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async (queue: string, data: Record<string, unknown>) => { jobs.push({ queue, data }); return null; } });
}
const row = async (id: string) => (await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.id, id)))[0]!;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "approvals");
  key = await newKey(db, p.tenantId, "admin", ["messages"]);
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("approval actions", () => {
  it("edits a pending message (markdown rendered, original kept, edited_by); 409 once approved", async () => {
    const { messageId } = await newMessage(db, p.tenantId);
    const a = await app();
    const res = await a.inject({ method: "PATCH", url: `/v1/messages/${messageId}`, headers: cookieJson(p.memberCookie), payload: { subject: "New subject", body_markdown: "Hello **there**" } });
    expect(res.statusCode).toBe(200);
    const r = await row(messageId);
    expect(r.subject).toBe("New subject");
    expect(r.bodyHtml).toContain("<strong>there</strong>");
    expect(r.bodyText).toContain("Hello there");
    expect(r.originalSubject).toBe("Hello");
    expect(r.editedBy).toMatch(/^user:/);

    const list = await a.inject({ method: "GET", url: "/v1/messages", headers: { cookie: p.memberCookie } });
    const item = list.json().messages.find((m: { id: string }) => m.id === messageId);
    expect(item.original).toEqual({ subject: "Hello", body_html: "<p>Hi</p>", body_text: "Hi" });

    expect((await a.inject({ method: "POST", url: `/v1/messages/${messageId}/approve`, headers: bearer(key), payload: {} })).statusCode).toBe(200);
    expect((await row(messageId)).approvedBy).toMatch(/^api_key:/);
    const stale = await a.inject({ method: "PATCH", url: `/v1/messages/${messageId}`, headers: cookieJson(p.memberCookie), payload: { subject: "Late" } });
    expect(stale.statusCode).toBe(409);
    expect((await row(messageId)).subject).toBe("New subject");
    expect((await a.inject({ method: "PATCH", url: `/v1/messages/${messageId}`, headers: cookieJson(p.memberCookie), payload: {} })).statusCode).toBe(400);
  });

  it("regenerates with a forced action type and enqueues content generation", async () => {
    const { messageId } = await newMessage(db, p.tenantId);
    const a = await app();
    jobs.length = 0;
    const res = await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: bearer(key), payload: { action_type: "tip_trick" } });
    expect(res.statusCode).toBe(200);
    expect(await row(messageId)).toMatchObject({ status: "pending_generation", forcedActionType: "tip_trick", brainActionType: "tip_trick" });
    expect(jobs).toEqual([{ queue: "claros.process-message", data: { tenant_id: p.tenantId, message_id: messageId } }]);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: bearer(key), payload: {} })).statusCode).toBe(409);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: bearer(key), payload: { action_type: "Bad Type" } })).statusCode).toBe(400);
  });

  it("revises with an instruction: draft kept, thread recorded, readable by GET /v1/messages/:id", async () => {
    const { messageId } = await newMessage(db, p.tenantId);
    const a = await app();
    jobs.length = 0;
    const tooLong = await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: cookieJson(p.memberCookie), payload: { instruction: "x".repeat(2001) } });
    expect(tooLong.statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: cookieJson(p.memberCookie), payload: { instruction: 42 } })).statusCode).toBe(400);

    const res = await a.inject({ method: "POST", url: `/v1/messages/${messageId}/regenerate`, headers: cookieJson(p.memberCookie), payload: { instruction: "  There is no /mcp page.  " } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "pending_generation", instruction: "There is no /mcp page." });
    expect(await row(messageId)).toMatchObject({ status: "pending_generation", subject: "Hello", revisionRequest: "There is no /mcp page." });
    expect(jobs).toEqual([{ queue: "claros.process-message", data: { tenant_id: p.tenantId, message_id: messageId } }]);

    const one = await a.inject({ method: "GET", url: `/v1/messages/${messageId}`, headers: bearer(key) });
    expect(one.statusCode).toBe(200);
    const m = one.json().message;
    expect(m).toMatchObject({ id: messageId, status: "pending_generation", revision_request: "There is no /mcp page." });
    expect(m.revisions).toEqual([{ instruction: "There is no /mcp page.", by: expect.stringMatching(/^user:/), at: expect.any(String) }]);

    expect((await a.inject({ method: "GET", url: "/v1/messages/00000000-0000-4000-8000-000000000000", headers: bearer(key) })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/v1/messages/not-a-uuid", headers: bearer(key) })).statusCode).toBe(404);
  });

  it("cancels and unapproves approved messages; stale clicks 409 without change", async () => {
    const a = await app();
    const c = await newMessage(db, p.tenantId, { status: "approved" });
    expect((await a.inject({ method: "POST", url: `/v1/messages/${c.messageId}/cancel`, headers: bearer(key), payload: {} })).statusCode).toBe(200);
    expect((await row(c.messageId)).status).toBe("cancelled");
    expect((await a.inject({ method: "POST", url: `/v1/messages/${c.messageId}/cancel`, headers: bearer(key), payload: {} })).statusCode).toBe(200);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${c.messageId}/unapprove`, headers: bearer(key), payload: {} })).statusCode).toBe(409);

    const sending = await newMessage(db, p.tenantId, { status: "sending" });
    expect((await a.inject({ method: "POST", url: `/v1/messages/${sending.messageId}/cancel`, headers: bearer(key), payload: {} })).statusCode).toBe(409);
    expect((await row(sending.messageId)).status).toBe("sending");

    const [ep] = await db.insert(webhookEndpoints).values({ tenantId: p.tenantId, slug: "ping", url: "http://127.0.0.1:9/x", events: ["message.pending_approval"] }).returning();
    const u = await newMessage(db, p.tenantId, { status: "approved" });
    expect((await a.inject({ method: "POST", url: `/v1/messages/${u.messageId}/unapprove`, headers: cookieJson(p.memberCookie), payload: {} })).statusCode).toBe(200);
    expect((await row(u.messageId)).status).toBe("pending_approval");
    const out = await db.select().from(webhookOutbox).where(eq(webhookOutbox.endpointId, ep!.id));
    expect(out.length).toBe(1);
    expect(out[0]!.dedupKey).toMatch(/^message\.pending_approval:\d+$/);
    expect(out[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await db.delete(webhookOutbox).where(eq(webhookOutbox.endpointId, ep!.id));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, ep!.id));
    expect((await a.inject({ method: "POST", url: `/v1/messages/00000000-0000-4000-8000-000000000000/cancel`, headers: bearer(key), payload: {} })).statusCode).toBe(404);
  });

  it("sends a draft the value gate held to review, or dismisses it; other statuses 409", async () => {
    const a = await app();
    const held = await newMessage(db, p.tenantId, { status: "value_gated" });
    await db.update(lifecycleMessages).set({ brainReasoning: "value_gated: The email is generic." }).where(eq(lifecycleMessages.id, held.messageId));
    const res = await a.inject({ method: "POST", url: `/v1/messages/${held.messageId}/release`, headers: cookieJson(p.memberCookie), payload: {} });
    expect(res.statusCode).toBe(200);
    const r = await row(held.messageId);
    expect(r.status).toBe("pending_approval");
    expect(r.statusReason).toBe("value_gate: The email is generic.");
    expect(r.subject).toBe("Hello");
    expect((await a.inject({ method: "POST", url: `/v1/messages/${held.messageId}/release`, headers: bearer(key), payload: {} })).statusCode).toBe(409);

    const other = await newMessage(db, p.tenantId, { status: "value_gated" });
    expect((await a.inject({ method: "POST", url: `/v1/messages/${other.messageId}/dismiss`, headers: bearer(key), payload: {} })).statusCode).toBe(200);
    const d = await row(other.messageId);
    expect(d.status).toBe("cancelled");
    expect(d.statusReason).toBe("dismissed");
    expect(d.rejectedBy).toMatch(/^api_key:/);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${other.messageId}/dismiss`, headers: bearer(key), payload: {} })).statusCode).toBe(200);

    const pending = await newMessage(db, p.tenantId);
    expect((await a.inject({ method: "POST", url: `/v1/messages/${pending.messageId}/dismiss`, headers: bearer(key), payload: {} })).statusCode).toBe(409);
  });

  it("excludes a person: suppression plus cancelled queue", async () => {
    const a = await app();
    const m1 = await newMessage(db, p.tenantId, { externalId: "exclude-me" });
    const m2 = await newMessage(db, p.tenantId, { contactId: m1.contactId, status: "approved" });
    const res = await a.inject({ method: "POST", url: "/v1/contacts/exclude-me/exclude", headers: bearer(key), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().suppressed).toBe(true);
    expect([...res.json().cancelled].sort()).toEqual([m1.messageId, m2.messageId].sort());
    const s = await db.select().from(suppressions).where(eq(suppressions.email, "exclude-me@example.com"));
    expect(s.length).toBe(1);
    expect((await a.inject({ method: "POST", url: "/v1/contacts/nobody-here/exclude", headers: bearer(key), payload: {} })).statusCode).toBe(404);
  });

  it("lists critical flows first", async () => {
    const t = await newProduct(db, "approvals-order");
    try {
      const n = await newMessage(db, t.tenantId);
      const c = await newMessage(db, t.tenantId, { flowClass: "critical" });
      const a = await app();
      const res = await a.inject({ method: "GET", url: "/v1/messages", headers: { cookie: t.memberCookie } });
      expect(res.json().messages.map((m: { id: string }) => m.id)).toEqual([c.messageId, n.messageId]);
      expect(res.json().messages[0].flow.class).toBe("critical");
      const paged = await a.inject({ method: "GET", url: "/v1/messages?limit=1", headers: { cookie: t.memberCookie } });
      const next = await a.inject({ method: "GET", url: `/v1/messages?limit=1&after=${paged.json().next_cursor}`, headers: { cookie: t.memberCookie } });
      expect(next.json().messages.map((m: { id: string }) => m.id)).toEqual([n.messageId]);
    } finally {
      await dropProduct(db, t.tenantId);
    }
  });
});
