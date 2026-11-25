/**
 * G1 admin API keys: creation (owner only, scopes, clr_ak_ prefix) and
 * authentication of the management routes (scope checks, product from the
 * key only, ingestion keys refused, admin keys refused by ingestion).
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "@claros/db/schema";
import { openDb, newProduct, newKey, app, bearer, cookieJson, newMessage, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let other: TestProduct;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "adminkeys");
  other = await newProduct(db, "adminkeys-other");
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await dropProduct(db, other.tenantId);
  await pool.end();
});

describe("admin key management", () => {
  it("owner creates an admin key with scopes; member is refused; scopes required", async () => {
    const a = await app(db);
    const res = await a.inject({
      method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.ownerCookie),
      payload: { kind: "admin", label: "CI", scopes: ["messages", "suppressions"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^clr_ak_/);
    expect(body.scopes).toEqual(["messages", "suppressions"]);

    const member = await a.inject({
      method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.memberCookie),
      payload: { kind: "admin", scopes: ["messages"] },
    });
    expect(member.statusCode).toBe(403);
    const noScopes = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.ownerCookie), payload: { kind: "admin" } });
    expect(noScopes.statusCode).toBe(400);
    const badScope = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.ownerCookie), payload: { kind: "admin", scopes: ["root"] } });
    expect(badScope.statusCode).toBe(400);
    const secretScopes = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.ownerCookie), payload: { kind: "secret", scopes: ["kb"] } });
    expect(secretScopes.statusCode).toBe(400);

    // Member cannot revoke an admin key; owner can, and it stops working.
    const revokeMember = await a.inject({ method: "POST", url: `/v1/ingestion/keys/${body.id}/revoke`, headers: { cookie: p.memberCookie } });
    expect(revokeMember.statusCode).toBe(403);
    const ok = await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(body.key) });
    expect(ok.statusCode).toBe(200);
    const revoke = await a.inject({ method: "POST", url: `/v1/ingestion/keys/${body.id}/revoke`, headers: { cookie: p.ownerCookie } });
    expect(revoke.statusCode).toBe(200);
    const after = await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(body.key) });
    expect(after.statusCode).toBe(401);
  });

  it("new ingestion keys use the clr_ prefixes", async () => {
    const a = await app(db);
    const pk = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.memberCookie), payload: { kind: "publishable" } });
    expect(pk.json().key).toMatch(/^clr_pk_/);
    const sk = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: cookieJson(p.memberCookie), payload: { kind: "secret" } });
    expect(sk.json().key).toMatch(/^clr_sk_/);
  });
});

describe("admin key authentication", () => {
  it("allows a route whose scope the key carries and refuses others with 403", async () => {
    const key = await newKey(db, p.tenantId, "admin", ["messages"]);
    const a = await app(db);
    expect((await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(key) })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/v1/suppressions", headers: bearer(key) })).statusCode).toBe(403);
    // GET /v1/flows takes the config scope (item 11); this key lacks it.
    expect((await a.inject({ method: "GET", url: "/v1/flows", headers: bearer(key) })).statusCode).toBe(403);
    // Routes without an admin scope stay session-only.
    expect((await a.inject({ method: "GET", url: "/v1/team", headers: bearer(key) })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/ingestion/keys", headers: bearer(key) })).statusCode).toBe(401);
  });

  it("acts on the key's product only, ignoring X-Claros-Product", async () => {
    const mine = await newMessage(db, p.tenantId);
    const theirs = await newMessage(db, other.tenantId);
    const key = await newKey(db, p.tenantId, "admin", ["messages"]);
    const a = await app(db);
    const list = await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(key, { "x-claros-product": other.slug }) });
    const ids = list.json().messages.map((m: { id: string }) => m.id);
    expect(ids).toContain(mine.messageId);
    expect(ids).not.toContain(theirs.messageId);
    const cross = await a.inject({ method: "POST", url: `/v1/messages/${theirs.messageId}/approve`, headers: bearer(key, { "x-claros-product": other.slug }), payload: {} });
    expect(cross.statusCode).toBe(404);
  });

  it("refuses ingestion keys on management routes and admin keys on ingestion", async () => {
    const secret = await newKey(db, p.tenantId, "secret");
    const admin = await newKey(db, p.tenantId, "admin", ["messages", "contacts:read"]);
    const a = await app(db);
    expect((await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(secret) })).statusCode).toBe(401);
    const track = await a.inject({ method: "POST", url: "/v1/track", headers: bearer(admin), payload: { userId: "u1", event: "x" } });
    expect(track.statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/messages", headers: bearer("clr_ak_unknown") })).statusCode).toBe(401);
  });

  it("archived products answer 409 to admin key writes", async () => {
    const t = await newProduct(db, "adminkeys-archived");
    try {
      const key = await newKey(db, t.tenantId, "admin", ["suppressions"]);
      await db.update(tenants).set({ archivedAt: new Date() }).where(eq(tenants.id, t.tenantId));
      const a = await app(db);
      expect((await a.inject({ method: "GET", url: "/v1/suppressions", headers: bearer(key) })).statusCode).toBe(200);
      const write = await a.inject({ method: "POST", url: "/v1/suppressions", headers: bearer(key), payload: { email: "a@example.com" } });
      expect(write.statusCode).toBe(409);
    } finally {
      await dropProduct(db, t.tenantId);
    }
  });
});
