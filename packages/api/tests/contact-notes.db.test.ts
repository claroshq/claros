/**
 * Person page actions on Postgres: contact notes (add, list, delete, tenant
 * isolation, validation), erasing a contact from a session (owner only,
 * notes erased with it), and the template a sent message's step renders
 * from (GET /v1/sent-log/:id template_ref).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { flows } from "@claros/db/schema";
import { openDb, newProduct, newMessage, app as buildTestApp, dropProduct, cookieJson, type TestDb, type TestProduct } from "./support/product.js";
import type { ClarosApp } from "../src/app.js";

const BASE = "http://localhost:3000";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
const products: TestProduct[] = [];

async function product(label: string): Promise<TestProduct> {
  const p = await newProduct(db, label);
  products.push(p);
  return p;
}

function req(method: string, path: string, cookie: string, body?: unknown) {
  return a.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: cookieJson(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("contact notes", () => {
  it("a member adds, lists (newest first, with author) and deletes notes", async () => {
    const p = await product("notes");
    const { contactId } = await newMessage(db, p.tenantId);

    const first = await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, { body: "  Asked for an invoice.  " });
    expect(first.status).toBe(201);
    const firstNote = (await first.json()) as any;
    expect(firstNote).toMatchObject({ body: "Asked for an invoice.", author: { email: `member-${p.slug}@example.com` } });

    const second = await req("POST", `/v1/contacts/${contactId}/notes`, p.ownerCookie, { body: "Offered a discount." });
    expect(second.status).toBe(201);

    const list = (await (await req("GET", `/v1/contacts/${contactId}/notes`, p.memberCookie)).json()) as any;
    expect(list.items.map((n: any) => n.body)).toEqual(["Offered a discount.", "Asked for an invoice."]);
    expect(list.items[0].author.id).toBe(p.ownerId);

    expect((await req("DELETE", `/v1/contacts/${contactId}/notes/${firstNote.id}`, p.memberCookie)).status).toBe(200);
    expect((await req("DELETE", `/v1/contacts/${contactId}/notes/${firstNote.id}`, p.memberCookie)).status).toBe(404);
    const after = (await (await req("GET", `/v1/contacts/${contactId}/notes`, p.memberCookie)).json()) as any;
    expect(after.items.map((n: any) => n.body)).toEqual(["Offered a discount."]);
  });

  it("rejects empty and oversized notes", async () => {
    const p = await product("notes-val");
    const { contactId } = await newMessage(db, p.tenantId);
    expect((await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, { body: "   " })).status).toBe(400);
    expect((await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, { body: "x".repeat(5001) })).status).toBe(400);
    expect((await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, {})).status).toBe(400);
  });

  it("another product's contact is not found", async () => {
    const p = await product("notes-a");
    const other = await product("notes-b");
    const { contactId } = await newMessage(db, p.tenantId);
    const note = (await (await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, { body: "mine" })).json()) as any;

    expect((await req("GET", `/v1/contacts/${contactId}/notes`, other.ownerCookie)).status).toBe(404);
    expect((await req("POST", `/v1/contacts/${contactId}/notes`, other.ownerCookie, { body: "x" })).status).toBe(404);
    expect((await req("DELETE", `/v1/contacts/${contactId}/notes/${note.id}`, other.ownerCookie)).status).toBe(404);
    expect((await req("GET", `/v1/contacts/not-a-uuid/notes`, p.memberCookie)).status).toBe(404);
  });
});

describe("DELETE /v1/contacts/:id from a session", () => {
  it("is refused for a member and erases the contact with its notes for an owner", async () => {
    const p = await product("erase");
    const { contactId } = await newMessage(db, p.tenantId);
    await req("POST", `/v1/contacts/${contactId}/notes`, p.memberCookie, { body: "note" });

    expect((await req("DELETE", `/v1/contacts/${contactId}`, p.memberCookie)).status).toBe(403);
    const res = await req("DELETE", `/v1/contacts/${contactId}`, p.ownerCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).erased).toBe(true);
    expect((await req("GET", `/v1/contacts/${contactId}`, p.ownerCookie)).status).toBe(404);
    expect((await req("GET", `/v1/contacts/${contactId}/notes`, p.ownerCookie)).status).toBe(404);
  });
});

describe("GET /v1/sent-log/:id template_ref", () => {
  const plan = (step: Record<string, unknown>) => ({
    trigger: { type: "manual", condition: {} },
    steps: [{ order: 1, action_type: "welcome", delay: "0m", ...step }],
  });

  it("names the step's template, the picked candidate's for a choose step, null for AI-drafted steps", async () => {
    const p = await product("sent-tpl");
    const cases: Array<[Record<string, unknown> | null, string | null]> = [
      [{ template_ref: "welcome-mail" }, "welcome-mail"],
      [{ type: "choose", candidates: [{ action_type: "other", template_ref: "other-mail" }, { action_type: "welcome", template_ref: "picked-mail" }] }, "picked-mail"],
      [{ brain_instruction: "Write a welcome." }, null],
      [null, null],
    ];
    for (const [step, expected] of cases) {
      const { messageId, flowId } = await newMessage(db, p.tenantId, { status: "sent" });
      await db.update(flows).set({ compiledPlan: step ? plan(step) : null }).where(eq(flows.id, flowId));
      const res = await req("GET", `/v1/sent-log/${messageId}`, p.memberCookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).message.template_ref).toBe(expected);
    }
  });
});
