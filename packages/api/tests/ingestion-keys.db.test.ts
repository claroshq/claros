/**
 * Ingestion key management tests (session-cookie dashboard scope).
 *
 * Covers /v1/ingestion/keys CRUD + /v1/ingestion/status:
 * - create publishable/secret keys; raw value returned exactly once
 * - list never exposes raw values or hashes
 * - allowed_origins validation and publishable-only enforcement
 * - revocation is idempotent and immediately effective for ingest auth
 * - tenant isolation (other tenant's keys are 404)
 * - status endpoint reflects a freshly ingested event
 *
 * Requires local Postgres (docker compose up postgres) with migration 0018
 * applied (api_keys.kind + allowed_origins).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { buildApp, SESSION_COOKIE_NAME } from "../src/index.js";
import { tenants, users, sessions, apiKeys } from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[ingestion-keys.test] DATABASE_URL is not set.");
}

const SLUG = "test-ingestion-keys";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantId: string;
let otherTenantId: string;
let sessionId: string;
let otherSessionId: string;

async function authedApp() {
  const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
  return app;
}

function sessionCookie(id: string) {
  return { [SESSION_COOKIE_NAME]: id };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[ingestion-keys.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    }
    console.warn("[ingestion-keys.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  // Clean previous runs
  for (const slug of [SLUG, `${SLUG}-other`]) {
    await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug}))`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }

  const [t] = await db.insert(tenants).values({ name: "Test Ingestion", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [u] = await db.insert(users).values({ tenantId, email: "ingestion-keys@example.com", role: "owner" }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({ tenantId, userId: u!.id, expiresAt: new Date(Date.now() + 86400000) }).returning({ id: sessions.id });
  sessionId = s!.id;

  const [t2] = await db.insert(tenants).values({ name: "Test Ingestion Other", slug: `${SLUG}-other`, plan: "free" }).returning({ id: tenants.id });
  otherTenantId = t2!.id;
  const [u2] = await db.insert(users).values({ tenantId: otherTenantId, email: "ingestion-keys-other@example.com", role: "owner" }).returning({ id: users.id });
  const [s2] = await db.insert(sessions).values({ tenantId: otherTenantId, userId: u2!.id, expiresAt: new Date(Date.now() + 86400000) }).returning({ id: sessions.id });
  otherSessionId = s2!.id;
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  for (const id of [tenantId, otherTenantId]) {
    await db.execute(sql`DELETE FROM events WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${id})`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}`);
  }
  await pool.end();
});

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[ingestion-keys.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("POST /v1/ingestion/keys", () => {
  it("creates a publishable key and returns the raw value once", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "publishable", label: "Marketing site" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toMatch(/^clr_pk_/);
    expect(body.kind).toBe("publishable");
    expect(body.prefix).toBe(body.key.slice(0, 8));
    expect(body.label).toBe("Marketing site");

    // The stored row carries only the hash
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, body.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.keyHash).not.toBe(body.key);
    expect(rows[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("creates a secret key with clr_sk_ prefix", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "secret" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toMatch(/^clr_sk_/);
    expect(body.kind).toBe("secret");
    expect(body.allowed_origins).toEqual([]);
    await app.close();
  });

  it("rejects allowed_origins on a secret key", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "secret", allowed_origins: ["https://app.example.com"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects malformed origins", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    for (const bad of ["app.example.com", "https://app.example.com/", "https://app.example.com/path", "not a url"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ingestion/keys",
        cookies: sessionCookie(sessionId),
        payload: { kind: "publishable", allowed_origins: [bad] },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("requires a session", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      payload: { kind: "publishable" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /v1/ingestion/keys", () => {
  it("lists keys without raw values or hashes", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys.length).toBeGreaterThanOrEqual(2);
    for (const k of body.keys) {
      expect(k.key).toBeUndefined();
      expect(k.key_hash).toBeUndefined();
      expect(k.prefix).toMatch(/^clr_(pk|sk)_/);
    }
    await app.close();
  });

  it("does not list another tenant's keys", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(otherSessionId),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).keys).toEqual([]);
    await app.close();
  });
});

describe("PATCH /v1/ingestion/keys/:id", () => {
  it("updates allowed_origins on a publishable key", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "publishable" },
    });
    const key = JSON.parse(created.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/ingestion/keys/${key.id}`,
      cookies: sessionCookie(sessionId),
      payload: { allowed_origins: ["https://app.example.com", "http://localhost:8000"] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).allowed_origins).toEqual(["https://app.example.com", "http://localhost:8000"]);
    await app.close();
  });

  it("rejects allowed_origins on a secret key", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "secret" },
    });
    const key = JSON.parse(created.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/ingestion/keys/${key.id}`,
      cookies: sessionCookie(sessionId),
      payload: { allowed_origins: ["https://app.example.com"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for another tenant's key", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "publishable" },
    });
    const key = JSON.parse(created.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/ingestion/keys/${key.id}`,
      cookies: sessionCookie(otherSessionId),
      payload: { label: "hijack" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /v1/ingestion/keys/:id/revoke", () => {
  it("revokes a key idempotently and the key stops authenticating", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(sessionId),
      payload: { kind: "secret" },
    });
    const key = JSON.parse(created.body);

    // Works before revocation
    const before = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${key.key}` },
      payload: { userId: "u_revoke", event: "before_revoke" },
    });
    expect(before.statusCode).toBe(200);

    const revoke1 = await app.inject({
      method: "POST",
      url: `/v1/ingestion/keys/${key.id}/revoke`,
      cookies: sessionCookie(sessionId),
    });
    expect(revoke1.statusCode).toBe(200);

    // Second revoke is a no-op 200
    const revoke2 = await app.inject({
      method: "POST",
      url: `/v1/ingestion/keys/${key.id}/revoke`,
      cookies: sessionCookie(sessionId),
    });
    expect(revoke2.statusCode).toBe(200);

    // Key no longer authenticates
    const after = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${key.key}` },
      payload: { userId: "u_revoke", event: "after_revoke" },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /v1/ingestion/status", () => {
  it("reports no events for a fresh tenant and reflects a new event", async () => {
    if (!dbAvailable) return;
    const app = await authedApp();

    // Other tenant has no events
    const empty = await app.inject({
      method: "GET",
      url: "/v1/ingestion/status",
      cookies: sessionCookie(otherSessionId),
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = JSON.parse(empty.body);
    expect(emptyBody.last_event).toBeNull();
    expect(emptyBody.events_last_24h).toBe(0);

    // Send an event through the real ingest path
    const created = await app.inject({
      method: "POST",
      url: "/v1/ingestion/keys",
      cookies: sessionCookie(otherSessionId),
      payload: { kind: "secret" },
    });
    const key = JSON.parse(created.body);
    const track = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${key.key}` },
      payload: { userId: "status_user", event: "status_probe" },
    });
    expect(track.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/v1/ingestion/status",
      cookies: sessionCookie(otherSessionId),
    });
    const body = JSON.parse(res.body);
    expect(body.last_event).not.toBeNull();
    expect(body.last_event.type).toBe("track");
    expect(body.last_event.event_name).toBe("status_probe");
    expect(body.last_event.user_id).toBe("status_user");
    expect(body.events_last_24h).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});
