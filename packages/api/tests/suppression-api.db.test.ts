/**
 * G12 suppression API and contact erasure over HTTP, with admin keys (G1)
 * and owner sessions. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { suppressions, contacts, lifecycleMessages, events } from "@claros/db/schema";
import { openDb, newProduct, newKey, app, bearer, cookieJson, newMessage, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "suppr-api");
  key = await newKey(db, p.tenantId, "admin", ["suppressions", "contacts:delete", "contacts:read"]);
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("suppression API", () => {
  it("bulk adds with a reason, reports skipped and invalid", async () => {
    const a = await app(db);
    const res = await a.inject({
      method: "POST", url: "/v1/suppressions", headers: bearer(key),
      payload: { emails: ["One@Example.com", "two@example.com", "not-an-email", "one@example.com"], reason: "hard_bounce" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ added: ["one@example.com", "two@example.com"], skipped: 1, invalid: ["not-an-email"] });
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, p.tenantId));
    expect(rows.find((r) => r.email === "one@example.com")).toMatchObject({ reason: "hard_bounce", source: "api" });

    const bad = await a.inject({ method: "POST", url: "/v1/suppressions", headers: bearer(key), payload: { emails: ["x@example.com"], reason: "whim" } });
    expect(bad.statusCode).toBe(400);
    // The single-address form keeps its v0.6 behaviour.
    const single = await a.inject({ method: "POST", url: "/v1/suppressions", headers: cookieJson(p.memberCookie), payload: { email: "single@example.com" } });
    expect(single.statusCode).toBe(201);
    expect(single.json()).toEqual({ email: "single@example.com", added: true });
  });

  it("deletes a suppression; complaint and hard_bounce need force", async () => {
    const a = await app(db);
    await a.inject({ method: "POST", url: "/v1/suppressions", headers: bearer(key), payload: { emails: ["del-m@example.com"], reason: "manual" } });
    await a.inject({ method: "POST", url: "/v1/suppressions", headers: bearer(key), payload: { emails: ["del-c@example.com"], reason: "complaint" } });
    expect((await a.inject({ method: "DELETE", url: "/v1/suppressions/del-m%40example.com", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    const refused = await a.inject({ method: "DELETE", url: "/v1/suppressions/DEL-C@example.com", headers: { authorization: `Bearer ${key}` } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toBe("complaint");
    expect((await a.inject({ method: "DELETE", url: "/v1/suppressions/del-c@example.com?force=1", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await a.inject({ method: "DELETE", url: "/v1/suppressions/del-c@example.com", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(404);
  });

  it("lists suppressions since a timestamp", async () => {
    const a = await app(db);
    await db.insert(suppressions).values({ tenantId: p.tenantId, email: "ancient@example.com", reason: "manual", createdAt: new Date("2020-01-01T00:00:00Z") });
    const res = await a.inject({ method: "GET", url: "/v1/suppressions?since=2021-01-01T00:00:00Z&limit=200", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    const emails = res.json().suppressions.map((s: { email: string }) => s.email);
    expect(emails).not.toContain("ancient@example.com");
    expect(emails).toContain("one@example.com");
    expect((await a.inject({ method: "GET", url: "/v1/suppressions?since=yesterday", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(400);
  });
});

describe("DELETE /v1/contacts/:external_id", () => {
  it("erases the contact with its messages and events; owner or contacts:delete key; member refused", async () => {
    const m = await newMessage(db, p.tenantId, { externalId: "erase-me" });
    await db.insert(events).values({ tenantId: p.tenantId, contactId: m.contactId, type: "track", eventName: "x", timestamp: new Date(), receivedAt: new Date() });
    const a = await app(db);
    expect((await a.inject({ method: "DELETE", url: "/v1/contacts/erase-me", headers: { cookie: p.memberCookie } })).statusCode).toBe(403);
    const readOnly = await newKey(db, p.tenantId, "admin", ["contacts:read"]);
    expect((await a.inject({ method: "DELETE", url: "/v1/contacts/erase-me", headers: { authorization: `Bearer ${readOnly}` } })).statusCode).toBe(403);
    const res = await a.inject({ method: "DELETE", url: "/v1/contacts/erase-me", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ erased: true, external_id: "erase-me" });
    expect(await db.select().from(contacts).where(and(eq(contacts.tenantId, p.tenantId), eq(contacts.externalId, "erase-me")))).toEqual([]);
    expect(await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.id, m.messageId))).toEqual([]);
    expect((await a.inject({ method: "DELETE", url: "/v1/contacts/erase-me", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(404);
    const owner = await newMessage(db, p.tenantId, { externalId: "erase-owner" });
    expect((await a.inject({ method: "DELETE", url: "/v1/contacts/erase-owner", headers: { cookie: p.ownerCookie } })).statusCode).toBe(200);
    expect(owner.contactId).toBeTruthy();
  });
});
