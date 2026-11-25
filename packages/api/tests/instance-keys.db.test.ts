/**
 * Item 11: GET /v1/capabilities, flows list / pause / resume with an admin
 * key (config scope), instance keys (clr_ik_: created by instance admins;
 * products, admin keys, transports, instance read, people erase by scope;
 * never ingestion or other product routes) and DELETE
 * /v1/instance/people/:email. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { users, flows, contacts, apiKeys, tenants } from "@claros/db/schema";
import { openDb, newProduct, newKey, app, bearer, cookieJson, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let other: TestProduct;
let adminCookie: string;
const created: string[] = [];
const keyIds: string[] = [];

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "instkeys");
  other = await newProduct(db, "instkeys-other");
  // Make p's owner an instance admin.
  await db.update(users).set({ instanceRole: "admin" }).where(eq(users.id, p.ownerId));
  adminCookie = p.ownerCookie;
});

afterAll(async () => {
  for (const id of keyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id));
  for (const id of created) await dropProduct(db, id);
  await dropProduct(db, p.tenantId);
  await dropProduct(db, other.tenantId);
  await pool.end();
});

/** Authorization only (bodyless POST). */
const auth = (raw: string) => ({ authorization: `Bearer ${raw}` });

async function instanceKey(scopes: string[]): Promise<string> {
  const a = await app(db);
  const res = await a.inject({ method: "POST", url: "/v1/instance/keys", headers: cookieJson(adminCookie), payload: { label: "ops", scopes } });
  expect(res.statusCode).toBe(201);
  keyIds.push(res.json().id);
  return res.json().key;
}

describe("capabilities", () => {
  it("reports the backend, runtime and features to sessions, admin keys and instance keys", async () => {
    const a = await app(db);
    const s = await a.inject({ method: "GET", url: "/v1/capabilities", headers: { cookie: p.memberCookie } });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ backend: "postgres", runtime: "node", kb: { semantic: true }, events: { partitioned: true } });
    expect(s.json().transports).toEqual(expect.arrayContaining(["resend", "smtp", "cloudflare"]));
    expect(s.json().features).toEqual(expect.arrayContaining(["instance_keys", "choose_step", "date_triggers"]));

    const ak = await newKey(db, p.tenantId, "admin", ["kb"]);
    expect((await a.inject({ method: "GET", url: "/v1/capabilities", headers: bearer(ak) })).statusCode).toBe(200);
    const ik = await instanceKey(["instance:read"]);
    expect((await a.inject({ method: "GET", url: "/v1/capabilities", headers: bearer(ik) })).statusCode).toBe(200);
    const ikNoRead = await instanceKey(["people:erase"]);
    expect((await a.inject({ method: "GET", url: "/v1/capabilities", headers: bearer(ikNoRead) })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/capabilities" })).statusCode).toBe(401);
    const sk = await newKey(db, p.tenantId, "secret");
    expect((await a.inject({ method: "GET", url: "/v1/capabilities", headers: bearer(sk) })).statusCode).toBe(401);
  });
});

describe("flows with an admin key", () => {
  it("lists flows and pauses / resumes by slug or id with the config scope", async () => {
    const a = await app(db);
    const plan = { trigger: { type: "event", condition: { event: "x" } }, steps: [{ order: 1, action_type: "a", delay: "0m" }] };
    const [f] = await db
      .insert(flows)
      .values({ tenantId: p.tenantId, slug: "nudge", name: "Nudge", triggerType: "event", triggerConfig: { event: "x" }, steps: plan.steps, status: "active", compileStatus: "ready", compiledPlan: plan })
      .returning({ id: flows.id });
    const config = await newKey(db, p.tenantId, "admin", ["config"]);
    const kb = await newKey(db, p.tenantId, "admin", ["kb"]);

    const list = await a.inject({ method: "GET", url: "/v1/flows", headers: bearer(config) });
    expect(list.statusCode).toBe(200);
    expect(list.json().flows.map((x: { id: string }) => x.id)).toContain(f!.id);
    expect((await a.inject({ method: "GET", url: "/v1/flows", headers: bearer(kb) })).statusCode).toBe(403);

    const pause = await a.inject({ method: "POST", url: "/v1/flows/nudge/pause", headers: auth(config) });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().status).toBe("paused");
    // Idempotent; resume by id.
    expect((await a.inject({ method: "POST", url: "/v1/flows/nudge/pause", headers: auth(config) })).json().status).toBe("paused");
    const resume = await a.inject({ method: "POST", url: `/v1/flows/${f!.id}/resume`, headers: auth(config) });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().status).toBe("active");
    expect((await a.inject({ method: "POST", url: "/v1/flows/nope/pause", headers: auth(config) })).statusCode).toBe(404);
    // The other product's key does not see this flow.
    const otherKey = await newKey(db, other.tenantId, "admin", ["config"]);
    expect((await a.inject({ method: "POST", url: "/v1/flows/nudge/pause", headers: auth(otherKey) })).statusCode).toBe(404);

    // A draft flow cannot be paused (validateStatusTransition).
    await db.insert(flows).values({ tenantId: p.tenantId, slug: "drafty", name: "D", triggerType: "event", triggerConfig: { event: "y" }, steps: [], status: "draft" });
    expect((await a.inject({ method: "POST", url: "/v1/flows/drafty/pause", headers: auth(config) })).statusCode).toBe(422);
    // Sessions keep working.
    expect((await a.inject({ method: "POST", url: "/v1/flows/nudge/pause", headers: { cookie: p.memberCookie } })).statusCode).toBe(200);
  });
});

describe("instance keys", () => {
  it("are created, listed and revoked by instance admins only", async () => {
    const a = await app(db);
    const res = await a.inject({ method: "POST", url: "/v1/instance/keys", headers: cookieJson(adminCookie), payload: { scopes: ["instance:read", "instance:read"] } });
    expect(res.statusCode).toBe(201);
    keyIds.push(res.json().id);
    expect(res.json().key).toMatch(/^clr_ik_/);
    expect(res.json().scopes).toEqual(["instance:read"]);
    const row = (await db.select().from(apiKeys).where(eq(apiKeys.id, res.json().id)))[0]!;
    expect(row.tenantId).toBeNull();
    expect(row.kind).toBe("instance");

    expect((await a.inject({ method: "POST", url: "/v1/instance/keys", headers: cookieJson(adminCookie), payload: { scopes: ["root"] } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/v1/instance/keys", headers: cookieJson(p.memberCookie), payload: { scopes: ["instance:read"] } })).statusCode).toBe(403);
    expect((await a.inject({ method: "POST", url: "/v1/instance/keys", headers: bearer(res.json().key), payload: { scopes: ["instance:read"] } })).statusCode).toBe(403);

    const list = await a.inject({ method: "GET", url: "/v1/instance/keys", headers: { cookie: adminCookie } });
    expect(list.json().keys.some((k: { id: string }) => k.id === res.json().id)).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain(res.json().key);

    expect((await a.inject({ method: "GET", url: "/v1/instance", headers: bearer(res.json().key) })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/v1/instance/health", headers: bearer(res.json().key) })).statusCode).toBe(200);
    const revoke = await a.inject({ method: "POST", url: `/v1/instance/keys/${res.json().id}/revoke`, headers: { cookie: adminCookie } });
    expect(revoke.statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/v1/instance", headers: bearer(res.json().key) })).statusCode).toBe(401);
  });

  it("manage products with products:write; instance:read lists them", async () => {
    const a = await app(db);
    const writer = await instanceKey(["products:write"]);
    const reader = await instanceKey(["instance:read"]);
    const slug = `ik-${randomUUID().slice(0, 8)}`;
    const create = await a.inject({ method: "POST", url: "/v1/products", headers: bearer(writer), payload: { name: "Keyed", slug } });
    expect(create.statusCode).toBe(201);
    created.push(create.json().product.id);
    expect((await a.inject({ method: "POST", url: "/v1/products", headers: bearer(reader), payload: { name: "No", slug: `${slug}-x` } })).statusCode).toBe(403);
    const patch = await a.inject({ method: "PATCH", url: `/v1/products/${slug}`, headers: bearer(writer), payload: { name: "Keyed 2" } });
    expect(patch.json().product.name).toBe("Keyed 2");
    const list = await a.inject({ method: "GET", url: "/v1/products", headers: bearer(reader) });
    expect(list.statusCode).toBe(200);
    expect(list.json().products.some((x: { slug: string }) => x.slug === slug)).toBe(true);
    // Product admin keys never authenticate instance routes.
    const ak = await newKey(db, p.tenantId, "admin", ["config"]);
    expect((await a.inject({ method: "POST", url: "/v1/products", headers: bearer(ak), payload: { name: "No", slug: `${slug}-y` } })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/instance", headers: bearer(ak) })).statusCode).toBe(401);
  });

  it("manage a product's admin keys with keys:write (product from the header)", async () => {
    const a = await app(db);
    const ik = await instanceKey(["keys:write"]);
    expect((await a.inject({ method: "GET", url: "/v1/ingestion/keys", headers: bearer(ik) })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/v1/ingestion/keys", headers: bearer(ik, { "x-claros-product": "no-such-product" }) })).statusCode).toBe(404);
    const created = await a.inject({ method: "POST", url: `/v1/ingestion/keys?product=${other.slug}`, headers: bearer(ik), payload: { kind: "admin", scopes: ["config"] } });
    expect(created.statusCode).toBe(201);
    const row = (await db.select().from(apiKeys).where(eq(apiKeys.id, created.json().id)))[0]!;
    expect(row.tenantId).toBe(other.tenantId);
    expect((await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: bearer(ik, { "x-claros-product": other.slug }), payload: { kind: "secret" } })).statusCode).toBe(403);
    const list = await a.inject({ method: "GET", url: "/v1/ingestion/keys", headers: bearer(ik, { "x-claros-product": other.slug }) });
    expect(list.json().keys.some((k: { id: string }) => k.id === created.json().id)).toBe(true);
    const revoke = await a.inject({ method: "POST", url: `/v1/ingestion/keys/${created.json().id}/revoke`, headers: { authorization: `Bearer ${ik}`, "x-claros-product": other.slug } });
    expect(revoke.statusCode).toBe(200);
    // The new admin key is revoked.
    expect((await a.inject({ method: "GET", url: "/v1/flows", headers: bearer(created.json().key) })).statusCode).toBe(401);
    // Without keys:write, refused; and never on other product routes or ingestion.
    const reader = await instanceKey(["instance:read"]);
    expect((await a.inject({ method: "GET", url: "/v1/ingestion/keys", headers: bearer(reader, { "x-claros-product": other.slug }) })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/flows", headers: bearer(ik, { "x-claros-product": other.slug }) })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/messages", headers: bearer(ik, { "x-claros-product": other.slug }) })).statusCode).toBe(401);
    const track = await a.inject({ method: "POST", url: "/v1/track", headers: bearer(ik), payload: { userId: "u1", event: "x" } });
    expect(track.statusCode).toBe(401);
  });

  it("manage a product's transports with transports:write", async () => {
    const a = await app(db);
    const ik = await instanceKey(["transports:write"]);
    const list = await a.inject({ method: "GET", url: "/v1/settings/transports", headers: bearer(ik, { "x-claros-product": other.slug }) });
    expect(list.statusCode).toBe(200);
    const routing = await a.inject({ method: "PUT", url: "/v1/settings/transport-routing", headers: bearer(ik, { "x-claros-product": other.slug }), payload: {} });
    expect(routing.statusCode).not.toBe(401);
    expect(routing.statusCode).not.toBe(403);
    const noScope = await instanceKey(["keys:write"]);
    expect((await a.inject({ method: "GET", url: "/v1/settings/transports", headers: bearer(noScope, { "x-claros-product": other.slug }) })).statusCode).toBe(403);
  });

  it("erase a person in every product with people:erase", async () => {
    const a = await app(db);
    const email = `erase-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(contacts).values({ tenantId: p.tenantId, externalId: "e1", email, lifecycleState: "signed_up" });
    await db.insert(contacts).values({ tenantId: other.tenantId, externalId: "e2", email: email.toUpperCase(), lifecycleState: "signed_up" });
    const reader = await instanceKey(["instance:read"]);
    expect((await a.inject({ method: "DELETE", url: `/v1/instance/people/${encodeURIComponent(email)}`, headers: { authorization: `Bearer ${reader}` } })).statusCode).toBe(403);
    const ik = await instanceKey(["people:erase"]);
    const res = await a.inject({ method: "DELETE", url: `/v1/instance/people/${encodeURIComponent(email)}`, headers: { authorization: `Bearer ${ik}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
    expect(res.json().erased.map((e: { product: string }) => e.product).sort()).toEqual([p.slug, other.slug].sort());
    const left = await db.select().from(contacts).where(sql`lower(${contacts.email}) = ${email}`);
    expect(left).toHaveLength(0);
    const again = await a.inject({ method: "DELETE", url: `/v1/instance/people/${encodeURIComponent(email)}`, headers: { cookie: adminCookie } });
    expect(again.json()).toEqual({ erased: [], count: 0 });
    expect((await a.inject({ method: "DELETE", url: "/v1/instance/people/not-an-email", headers: { authorization: `Bearer ${ik}` } })).statusCode).toBe(400);
    expect((await a.inject({ method: "DELETE", url: `/v1/instance/people/${encodeURIComponent(email)}`, headers: { cookie: p.memberCookie } })).statusCode).toBe(403);
    void tenants;
  });
});
