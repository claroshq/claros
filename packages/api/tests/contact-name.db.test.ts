/**
 * Editing a person's name from the dashboard on Postgres: PUT locks the
 * name so identify calls no longer change it, DELETE clears the lock and
 * the next identify sets the name again. Validation and tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { contacts } from "@claros/db/schema";
import { openDb, newProduct, newKey, app as buildTestApp, dropProduct, cookieJson, bearer, type TestDb, type TestProduct } from "./support/product.js";
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

async function identify(key: string, userId: string, traits: Record<string, unknown>) {
  const res = await a.fetch(new Request(`${BASE}/v1/identify`, {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify({ userId, traits }),
  }));
  expect(res.status).toBeLessThan(300);
}

async function contactByUser(p: TestProduct, userId: string) {
  const [row] = await db.select({ id: contacts.id }).from(contacts)
    .where(and(eq(contacts.tenantId, p.tenantId), eq(contacts.externalId, userId)));
  const id = row!.id;
  return ((await (await req("GET", `/v1/contacts/${id}`, p.memberCookie)).json()) as any).contact;
}

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("contact name", () => {
  it("an edited name is locked against identify until the lock is cleared", async () => {
    const p = await product("name");
    const key = await newKey(db, p.tenantId, "secret");
    await identify(key, "name-u1", { name: "ada", company: "Acme" });
    const before = await contactByUser(p, "name-u1");
    expect(before).toMatchObject({ name: "ada", name_locked_at: null });

    const put = await req("PUT", `/v1/contacts/${before.id}/name`, p.memberCookie, { name: "  Ada Lovelace " });
    expect(put.status).toBe(200);
    const detail = (await put.json()) as any;
    expect(detail.contact.name).toBe("Ada Lovelace");
    expect(detail.contact.name_locked_at).not.toBeNull();

    await identify(key, "name-u1", { name: "ada", company: "Acme Ltd" });
    expect(await contactByUser(p, "name-u1")).toMatchObject({ name: "Ada Lovelace", company: "Acme Ltd" });

    const del = await req("DELETE", `/v1/contacts/${before.id}/name`, p.memberCookie);
    expect(del.status).toBe(200);
    expect(((await del.json()) as any).contact).toMatchObject({ name: "Ada Lovelace", name_locked_at: null });

    await identify(key, "name-u1", { name: "ada" });
    expect((await contactByUser(p, "name-u1")).name).toBe("ada");
  });

  it("rejects an empty or oversized name and another product's contact", async () => {
    const p = await product("name-val");
    const other = await product("name-other");
    const key = await newKey(db, p.tenantId, "secret");
    await identify(key, "name-u2", { name: "bob" });
    const { id } = await contactByUser(p, "name-u2");
    expect((await req("PUT", `/v1/contacts/${id}/name`, p.memberCookie, { name: "   " })).status).toBe(400);
    expect((await req("PUT", `/v1/contacts/${id}/name`, p.memberCookie, { name: "x".repeat(201) })).status).toBe(400);
    expect((await req("PUT", `/v1/contacts/${id}/name`, p.memberCookie, {})).status).toBe(400);
    expect((await req("PUT", `/v1/contacts/${id}/name`, other.memberCookie, { name: "x" })).status).toBe(404);
    expect((await req("DELETE", `/v1/contacts/${id}/name`, other.memberCookie)).status).toBe(404);
    expect((await req("PUT", `/v1/contacts/not-a-uuid/name`, p.memberCookie, { name: "x" })).status).toBe(404);
  });
});
