/**
 * Multi-product instances against a real Postgres database.
 *
 *   - product switching with the X-Claros-Product header and ?product=
 *   - a user without a membership (and an unknown slug) gets 401
 *   - an instance admin sees and acts on every product
 *   - an archived product keeps reads and answers writes with 409
 *   - two products with the same contact email stay isolated
 *   - products routes: create, update, archive (instance admin only)
 *   - writers keep memberships in sync: invite accept across products,
 *     team role change and removal in a non-home product
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, eq, inArray, like } from "drizzle-orm";
import { createHash } from "node:crypto";
import { buildApp } from "../src/index.js";
import { contacts, invites, memberships, sessions, suppressions, tenants, users } from "@claros/db/schema";
import type { ClarosApp } from "../src/index.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[products.test] DATABASE_URL is not set (see .env.example).");
}

const pool = new pg.Pool({ connectionString: TEST_DB_URL });
const db = drizzle(pool);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const slugA = `p3a-${RUN}`;
const slugB = `p3b-${RUN}`;
const slugC = `p3c-${RUN}`;
const createdSlug = `p3new-${RUN}`;
const SHARED_EMAIL = `shared-${RUN}@example.com`;

let app: ClarosApp;
const ids = { a: "", b: "", c: "" };
/** Member of A (home, owner) and B (membership, member). */
let multiUserId: string;
let multiSession: string;
/** Only in C (home, owner). */
let cOwnerId: string;
let cOwnerSession: string;
/** Instance admin, home A. */
let adminId: string;
let adminSession: string;
const contactIds = { a: "", b: "" };

const expires = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

async function newSession(tenantId: string, userId: string): Promise<string> {
  const [s] = await db.insert(sessions).values({ tenantId, userId, expiresAt: expires() }).returning({ id: sessions.id });
  return s!.id;
}

function get(url: string, session: string, product?: string) {
  return app.inject({
    method: "GET",
    url,
    cookies: { claros_session: session },
    headers: product ? { "x-claros-product": product } : {},
  });
}

function send(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, session: string, payload?: unknown, product?: string) {
  return app.inject({
    method,
    url,
    cookies: { claros_session: session },
    headers: product ? { "x-claros-product": product } : {},
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false, db: db as never, dashboardUrl: "http://localhost:5173" });

  for (const [k, slug] of [["a", slugA], ["b", slugB], ["c", slugC]] as const) {
    const [t] = await db.insert(tenants).values({ name: `Product ${k.toUpperCase()}`, slug, plan: "free" }).returning({ id: tenants.id });
    ids[k] = t!.id;
  }

  const [multi] = await db
    .insert(users)
    .values({ tenantId: ids.a, email: `multi-${RUN}@test.local`, role: "owner" })
    .returning({ id: users.id });
  multiUserId = multi!.id;
  await db.insert(memberships).values([
    { userId: multiUserId, tenantId: ids.a, role: "owner" },
    { userId: multiUserId, tenantId: ids.b, role: "member" },
  ]);
  multiSession = await newSession(ids.a, multiUserId);

  const [cOwner] = await db
    .insert(users)
    .values({ tenantId: ids.c, email: `cowner-${RUN}@test.local`, role: "owner" })
    .returning({ id: users.id });
  cOwnerId = cOwner!.id;
  await db.insert(memberships).values({ userId: cOwnerId, tenantId: ids.c, role: "owner" });
  cOwnerSession = await newSession(ids.c, cOwnerId);

  const [admin] = await db
    .insert(users)
    .values({ tenantId: ids.a, email: `admin-${RUN}@test.local`, role: "member", instanceRole: "admin" })
    .returning({ id: users.id });
  adminId = admin!.id;
  await db.insert(memberships).values({ userId: adminId, tenantId: ids.a, role: "member" });
  adminSession = await newSession(ids.a, adminId);

  // The same contact email in A and B.
  for (const k of ["a", "b"] as const) {
    const [ct] = await db
      .insert(contacts)
      .values({ tenantId: ids[k], externalId: `ext-${k}`, email: SHARED_EMAIL, lifecycleState: "signed_up", name: `Contact ${k}` })
      .returning({ id: contacts.id });
    contactIds[k] = ct!.id;
  }
});

afterAll(async () => {
  const created = await db.select({ id: tenants.id }).from(tenants).where(like(tenants.slug, `p3%-${RUN}`));
  const tenantIds = created.map((t) => t.id);
  if (tenantIds.length > 0) {
    await db.delete(suppressions).where(inArray(suppressions.tenantId, tenantIds));
    await db.delete(contacts).where(inArray(contacts.tenantId, tenantIds));
    await db.delete(invites).where(inArray(invites.tenantId, tenantIds));
    await db.delete(sessions).where(inArray(sessions.tenantId, tenantIds));
    await db.delete(memberships).where(inArray(memberships.tenantId, tenantIds));
    await db.delete(users).where(inArray(users.tenantId, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  }
  await app.close();
  await pool.end();
});

describe("product switching", () => {
  it("lists the products the user can act on", async () => {
    const res = await get("/v1/products", multiSession);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.instance_admin).toBe(false);
    const bySlug = Object.fromEntries(body.products.map((p: { slug: string }) => [p.slug, p]));
    expect(Object.keys(bySlug).sort()).toEqual([slugA, slugB].sort());
    expect(bySlug[slugA].role).toBe("owner");
    expect(bySlug[slugB].role).toBe("member");
    expect(bySlug[slugB].archived).toBe(false);
  });

  it("acts on the session's product without a header (as before)", async () => {
    const res = await get("/v1/contacts", multiSession);
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.payload).contacts as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([contactIds.a]);
  });

  it("switches product with the X-Claros-Product header", async () => {
    const res = await get("/v1/contacts", multiSession, slugB);
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.payload).contacts as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([contactIds.b]);
  });

  it("switches product with ?product=", async () => {
    const res = await get(`/v1/contacts?product=${slugB}`, multiSession);
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.payload).contacts as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([contactIds.b]);
  });

  it("uses the role of the selected product", async () => {
    // Owner in A: may list invites. Member in B: may not.
    expect((await get("/v1/team/invites", multiSession, slugA)).statusCode).toBe(200);
    expect((await get("/v1/team/invites", multiSession, slugB)).statusCode).toBe(403);
    const me = JSON.parse((await get("/auth/me", multiSession, slugB)).payload);
    expect(me.user.role).toBe("member");
    expect(me.user.tenantId).toBe(ids.b);
  });

  it("answers 401 for a product the user is not a member of", async () => {
    expect((await get("/v1/contacts", multiSession, slugC)).statusCode).toBe(401);
    expect((await get(`/v1/contacts?product=${slugC}`, multiSession)).statusCode).toBe(401);
  });

  it("answers 401 for an unknown product slug", async () => {
    expect((await get("/v1/contacts", multiSession, `nope-${RUN}`)).statusCode).toBe(401);
  });
});

describe("isolation between products", () => {
  it("does not serve product B's contact through product A", async () => {
    expect((await get(`/v1/contacts/${contactIds.b}`, multiSession)).statusCode).toBe(404);
    expect((await get(`/v1/contacts/${contactIds.b}`, multiSession, slugA)).statusCode).toBe(404);
    expect((await get(`/v1/contacts/${contactIds.a}`, multiSession, slugB)).statusCode).toBe(404);
  });

  it("serves each product's own contact with the same email", async () => {
    const a = JSON.parse((await get(`/v1/contacts/${contactIds.a}`, multiSession, slugA)).payload);
    const b = JSON.parse((await get(`/v1/contacts/${contactIds.b}`, multiSession, slugB)).payload);
    expect(a.contact.email).toBe(SHARED_EMAIL);
    expect(b.contact.email).toBe(SHARED_EMAIL);
    expect(a.contact.id).not.toBe(b.contact.id);
  });

  it("keeps a user of another product out of both", async () => {
    expect((await get(`/v1/contacts/${contactIds.a}`, cOwnerSession)).statusCode).toBe(404);
    expect((await get(`/v1/contacts/${contactIds.a}`, cOwnerSession, slugA)).statusCode).toBe(401);
  });
});

describe("instance admin", () => {
  it("sees every product", async () => {
    const body = JSON.parse((await get("/v1/products", adminSession)).payload);
    expect(body.instance_admin).toBe(true);
    const slugs = body.products.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining([slugA, slugB, slugC]));
    expect(body.products.every((p: { role: string }) => p.role === "owner")).toBe(true);
  });

  it("acts on a product without a membership, as owner", async () => {
    expect((await get("/v1/contacts", adminSession, slugC)).statusCode).toBe(200);
    expect((await get("/v1/team/invites", adminSession, slugC)).statusCode).toBe(200);
  });

  it("reads instance settings and users; writes a setting", async () => {
    const put = await send("PUT", `/v1/instance/settings/p3-test-${RUN}`, adminSession, { value: { on: true } });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.payload).value).toEqual({ on: true });

    const res = await get("/v1/instance", adminSession);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.settings[`p3-test-${RUN}`]).toEqual({ on: true });
    const multi = body.users.find((u: { id: string }) => u.id === multiUserId);
    expect(multi.home_product_id).toBe(ids.a);
    expect(multi.memberships.map((m: { slug: string }) => m.slug).sort()).toEqual([slugA, slugB].sort());

    await pool.query("DELETE FROM instance_settings WHERE key = $1", [`p3-test-${RUN}`]);
  });

  it("refuses instance routes to non-admins", async () => {
    expect((await get("/v1/instance", multiSession)).statusCode).toBe(403);
    expect((await send("PUT", "/v1/instance/settings/x", multiSession, { value: 1 })).statusCode).toBe(403);
    expect((await send("POST", "/v1/products", multiSession, { name: "X", slug: `p3x-${RUN}` })).statusCode).toBe(403);
    expect((await send("POST", `/v1/products/${slugB}/archive`, multiSession)).statusCode).toBe(403);
    expect((await send("PATCH", `/v1/products/${slugB}`, multiSession, { name: "Y" })).statusCode).toBe(403);
  });

  it("answers 401 on product and instance routes without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/products" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/instance" })).statusCode).toBe(401);
  });
});

describe("products routes", () => {
  it("creates a product; the creator becomes its owner", async () => {
    const res = await send("POST", "/v1/products", adminSession, { name: "New Product", slug: createdSlug, locale: "en" });
    expect(res.statusCode).toBe(201);
    const { product } = JSON.parse(res.payload);
    expect(product.slug).toBe(createdSlug);
    expect(product.locale).toBe("en");
    expect(product.archived).toBe(false);

    const rows = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, adminId), eq(memberships.tenantId, product.id)));
    expect(rows).toEqual([{ role: "owner" }]);
  });

  it("refuses a taken slug with 409 and a bad slug with 400", async () => {
    expect((await send("POST", "/v1/products", adminSession, { name: "Dup", slug: createdSlug })).statusCode).toBe(409);
    expect((await send("POST", "/v1/products", adminSession, { name: "Bad", slug: "Bad Slug" })).statusCode).toBe(400);
  });

  it("updates name, locale and public host; a host used twice is 409", async () => {
    const host = `p3-${RUN}.example.com`;
    const res = await send("PATCH", `/v1/products/${createdSlug}`, adminSession, { name: "Renamed", locale: "pt-BR", public_host: host.toUpperCase() });
    expect(res.statusCode).toBe(200);
    const { product } = JSON.parse(res.payload);
    expect(product).toMatchObject({ name: "Renamed", locale: "pt-BR", public_host: host });

    const dup = await send("PATCH", `/v1/products/${slugC}`, adminSession, { public_host: host });
    expect(dup.statusCode).toBe(409);
    expect((await send("PATCH", `/v1/products/nope-${RUN}`, adminSession, { name: "Z" })).statusCode).toBe(404);
  });
});

describe("archived product", () => {
  it("keeps reads and answers writes with 409 until unarchived", async () => {
    const archived = await send("POST", `/v1/products/${slugB}/archive`, adminSession);
    expect(archived.statusCode).toBe(200);
    expect(JSON.parse(archived.payload).product.archived).toBe(true);

    expect((await get("/v1/contacts", multiSession, slugB)).statusCode).toBe(200);
    const write = await send("POST", "/v1/suppressions", multiSession, { email: `x-${RUN}@example.com` }, slugB);
    expect(write.statusCode).toBe(409);
    expect(JSON.parse(write.payload)).toEqual({ error: "Product is archived." });

    const listed = JSON.parse((await get("/v1/products", multiSession)).payload);
    expect(listed.products.find((p: { slug: string }) => p.slug === slugB).archived).toBe(true);

    // Other products are unaffected.
    expect((await send("POST", "/v1/suppressions", multiSession, { email: `x-${RUN}@example.com` }, slugA)).statusCode).toBe(201);

    expect((await send("POST", `/v1/products/${slugB}/unarchive`, adminSession)).statusCode).toBe(200);
    expect((await send("POST", "/v1/suppressions", multiSession, { email: `x-${RUN}@example.com` }, slugB)).statusCode).toBe(201);
  });
});

describe("memberships stay in sync with team writes", () => {
  let inviteeSession: string;

  it("an invite accepted by a user of another product adds a membership, not a second user", async () => {
    // C's owner invites the multi-product user into C.
    const inv = await send("POST", "/v1/team/invites", cOwnerSession, { email: `multi-${RUN}@test.local`, role: "member" });
    expect(inv.statusCode).toBe(200);
    const token = /[?&]token=([^&]+)/.exec(JSON.parse(inv.payload).invite.invite_url as string)![1]!;

    const accept = await app.inject({ method: "POST", url: "/invite/accept", payload: { token } });
    expect(accept.statusCode).toBe(302);
    const cookie = accept.headers["set-cookie"];
    inviteeSession = /claros_session=([^;]+)/.exec(Array.isArray(cookie) ? cookie.join(";") : String(cookie))![1]!;

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, `multi-${RUN}@test.local`));
    expect(rows).toEqual([{ id: multiUserId }]);
    const m = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, multiUserId), eq(memberships.tenantId, ids.c)));
    expect(m).toEqual([{ role: "member" }]);

    const team = JSON.parse((await get("/v1/team", cOwnerSession)).payload);
    expect(team.members.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([cOwnerId, multiUserId]));
    expect((await get("/v1/contacts", multiSession, slugC)).statusCode).toBe(200);
  });

  it("a role change in a non-home product updates the membership only", async () => {
    const res = await send("PATCH", `/v1/team/${multiUserId}/role`, cOwnerSession, { role: "owner" });
    expect(res.statusCode).toBe(200);
    const [m] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, multiUserId), eq(memberships.tenantId, ids.c)));
    expect(m!.role).toBe("owner");
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, multiUserId));
    expect(u!.role).toBe("owner"); // home role (A) unchanged
    await send("PATCH", `/v1/team/${multiUserId}/role`, cOwnerSession, { role: "member" });
    const [u2] = await db.select({ role: users.role }).from(users).where(eq(users.id, multiUserId));
    expect(u2!.role).toBe("owner");
  });

  it("removal from a non-home product ends access there and keeps the user active", async () => {
    const res = await send("DELETE", `/v1/team/${multiUserId}`, cOwnerSession);
    expect(res.statusCode).toBe(200);

    expect((await get("/v1/contacts", multiSession, slugC)).statusCode).toBe(401);
    expect((await get("/v1/contacts", inviteeSession)).statusCode).toBe(401); // session opened on C
    expect((await get("/v1/contacts", multiSession, slugA)).statusCode).toBe(200);
    const [u] = await db.select({ deactivatedAt: users.deactivatedAt }).from(users).where(eq(users.id, multiUserId));
    expect(u!.deactivatedAt).toBeNull();
  });

  it("a role change in the home product updates users.role and the membership", async () => {
    // The admin is a member of A (home). Promote through A's owner.
    const res = await send("PATCH", `/v1/team/${adminId}/role`, multiSession, { role: "owner" }, slugA);
    expect(res.statusCode).toBe(200);
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, adminId));
    expect(u!.role).toBe("owner");
    const [m] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, adminId), eq(memberships.tenantId, ids.a)));
    expect(m!.role).toBe("owner");
  });
});

describe("ingest keys", () => {
  it("admin and instance keys never authenticate ingestion", async () => {
    const raw = `cl_admin_${RUN}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await pool.query(
      "INSERT INTO api_keys (tenant_id, key_hash, prefix, kind) VALUES ($1, $2, 'cl_admin', 'admin'), (NULL, $3, 'cl_inst_', 'instance')",
      [ids.a, hash, createHash("sha256").update(`${raw}-i`).digest("hex")],
    );
    try {
      for (const key of [raw, `${raw}-i`]) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/track",
          headers: { authorization: `Bearer ${key}` },
          payload: { userId: "u1", event: "x" },
        });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await pool.query("DELETE FROM api_keys WHERE prefix IN ('cl_admin', 'cl_inst_') AND key_hash IN ($1, $2)", [
        hash,
        createHash("sha256").update(`${raw}-i`).digest("hex"),
      ]);
    }
  });
});
