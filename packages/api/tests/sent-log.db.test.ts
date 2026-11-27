/**
 * GET /v1/sent-log: numbered pages (?page) next to the cursor (?after).
 * GET /v1/sent-log/:id: the mail as received (preview_html).
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tenants, lifecycleMessages } from "@claros/db/schema";
import { openDb, newProduct, app, newMessage, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "sent-log-pages");
  for (let i = 0; i < 5; i++) await newMessage(db, p.tenantId, { status: "sent" });
  await newMessage(db, p.tenantId, { status: "failed" });
  await newMessage(db, p.tenantId, { status: "pending_approval" }); // not in the log
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("GET /v1/sent-log", () => {
  const get = async (qs: string) => {
    const a = await app(db);
    const res = await a.inject({ method: "GET", url: `/v1/sent-log${qs}`, headers: { cookie: p.memberCookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as { messages: { id: string }[]; next_cursor: string | null; page?: number; page_size?: number; total?: number };
  };

  // Test messages have no sent_at: numbered pages reach them, the cursor
  // does not (row comparison with NULL), which is one reason the dashboard
  // pages by number.
  it("serves numbered pages with the filtered total", async () => {
    const all = (await get("?limit=50")).messages.map((m) => m.id);
    expect(all).toHaveLength(6);
    const p1 = await get("?page=1&limit=4");
    const p2 = await get("?page=2&limit=4");
    expect(p1).toMatchObject({ page: 1, page_size: 4, total: 6, next_cursor: null });
    expect(p2).toMatchObject({ page: 2, page_size: 4, total: 6 });
    expect([...p1.messages, ...p2.messages].map((m) => m.id)).toEqual(all);
    expect(await get("?page=3&limit=4")).toMatchObject({ messages: [], total: 6 });
    expect(await get("?page=1&status=failed")).toMatchObject({ total: 1 });
    // A bad page number is page 1.
    expect(await get("?page=abc&limit=4")).toMatchObject({ page: 1 });
  });

  it("keeps the cursor response without ?page", async () => {
    const first = await get("?limit=4");
    expect(first.total).toBeUndefined();
    expect(first.next_cursor).not.toBeNull();
    expect(first.page).toBeUndefined();
  });
});

describe("GET /v1/sent-log/:id", () => {
  it("returns preview_html: the body in the email template with links tagged as sent", async () => {
    const q = await newProduct(db, "sent-log-detail");
    try {
      await db
        .update(tenants)
        .set({ settings: { postal_address: "1 Test St", link_tracking: { domains: ["example.com"], params: { utm_source: "claros" }, click_id: true } } })
        .where(eq(tenants.id, q.tenantId));
      const { messageId } = await newMessage(db, q.tenantId, { status: "sent" });
      await db
        .update(lifecycleMessages)
        .set({ bodyHtml: '<p>Hi <a href="https://example.com/start">start</a></p>' })
        .where(eq(lifecycleMessages.id, messageId));

      const a = await app(db);
      const res = await a.inject({ method: "GET", url: `/v1/sent-log/${messageId}`, headers: { cookie: q.memberCookie } });
      expect(res.statusCode).toBe(200);
      const msg = (res.json() as { message: { body_html: string; preview_html: string | null; preheader: string | null } }).message;
      expect(msg.body_html).toBe('<p>Hi <a href="https://example.com/start">start</a></p>');
      expect(msg.preview_html).toMatch(/^<!DOCTYPE html>/);
      expect(msg.preview_html).toContain("1 Test St");
      expect(msg.preview_html).toContain(`https://example.com/start?utm_source=claros&amp;clr_cid=${messageId}`);
      expect(msg.preheader).toBeNull();
    } finally {
      await dropProduct(db, q.tenantId);
    }
  });
});
