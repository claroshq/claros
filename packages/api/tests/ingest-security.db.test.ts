/**
 * Ingest security surface tests: CORS, origin allowlists, body-key auth,
 * text/plain beacon parsing, and rate limiting.
 *
 * Covers:
 * - OPTIONS preflight answers without credentials and echoes the Origin
 * - publishable key + Origin: ACAO echoed on success
 * - publishable key + allowlisted origin passes, other origins get 403
 *   with no ACAO header (browser blocks the response)
 * - secret key + Origin: request succeeds but no ACAO is emitted, so a
 *   browser cannot use a secret key cross-origin
 * - body-carried key: publishable accepted, secret rejected
 * - text/plain body parses as JSON (the beacon path)
 * - rate limit: publishable keys get 429 + Retry-After past the window cap
 * - no-credential invariant: Access-Control-Allow-Credentials never emitted
 *
 * Requires local Postgres with migration 0018 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp, hashApiKey } from "../src/index.js";
import { tenants, apiKeys } from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[ingest-security.test] DATABASE_URL is not set.");
}

const SLUG = "test-ingest-security";
const ORIGIN = "http://localhost:8000";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantId: string;
let pubKey: string;
let pubLimitedKey: string;
let secretKey: string;

async function insertKey(kind: "publishable" | "secret", allowedOrigins: string[] | null) {
  const raw = `${kind === "publishable" ? "cl_pub_" : "cl_live_"}${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({
    tenantId,
    keyHash: hashApiKey(raw),
    prefix: raw.slice(0, 8),
    kind,
    allowedOrigins,
  });
  return raw;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[ingest-security.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    }
    console.warn("[ingest-security.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);

  const [t] = await db.insert(tenants).values({ name: "Test Ingest Security", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;

  pubKey = await insertKey("publishable", [ORIGIN]);
  pubLimitedKey = await insertKey("publishable", null);
  secretKey = await insertKey("secret", null);
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM ops_events WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM ops_alerts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[ingest-security.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("OPTIONS preflight", () => {
  it("answers 204 with CORS headers and no credentials", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/track",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("content-type");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    await app.close();
  });

  it("OPTIONS /v1/identify also answers", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/identify",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("does not touch dashboard routes (no CORS headers on /v1/flows OPTIONS)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/flows",
      headers: { origin: ORIGIN, "access-control-request-method": "GET" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("publishable key origin handling", () => {
  it("allowlisted origin: 200 with ACAO echo", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${pubKey}`, origin: ORIGIN },
      payload: { userId: "cors_user", event: "cors_ok" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["vary"]).toContain("Origin");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    await app.close();
  });

  it("non-allowlisted origin: 403 with no ACAO", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${pubKey}`, origin: "https://evil.example.com" },
      payload: { userId: "cors_user", event: "cors_denied" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("no allowlist on key: any origin echoes", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${pubLimitedKey}`, origin: "https://anything.example.com" },
      payload: { userId: "cors_user", event: "cors_open" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://anything.example.com");
    await app.close();
  });

  it("no Origin header (server-to-server): works, no CORS headers", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${pubKey}` },
      payload: { userId: "cors_user", event: "cors_no_origin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("secret key browser posture", () => {
  it("secret key + Origin: 200 but no ACAO, so browsers cannot read it", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${secretKey}`, origin: ORIGIN },
      payload: { userId: "cors_user", event: "secret_browser" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("body-carried key (beacon path)", () => {
  it("publishable key in body authenticates", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { "content-type": "text/plain", origin: ORIGIN },
      payload: JSON.stringify({ key: pubLimitedKey, userId: "beacon_user", event: "beacon_event" }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    await app.close();
  });

  it("secret key in body is rejected", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ key: secretKey, userId: "beacon_user", event: "beacon_secret" }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("text/plain with invalid JSON is a 400, not a 500", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { "content-type": "text/plain", authorization: `Bearer ${pubLimitedKey}` },
      payload: "this is not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("the key field is never persisted in event properties", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ key: pubLimitedKey, userId: "beacon_user", event: "beacon_no_leak", properties: { a: 1 } }),
    });
    const rows = await db.execute(
      sql`SELECT properties, context FROM events WHERE tenant_id = ${tenantId} AND event_name = 'beacon_no_leak'`,
    );
    expect(rows.rows.length).toBe(1);
    const props = rows.rows[0]!.properties as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain(pubLimitedKey);
    expect(props.key).toBeUndefined();
    await app.close();
  });
});

describe("Segment-style Basic auth", () => {
  it("accepts the write key as the Basic auth username", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const basic = Buffer.from(`${secretKey}:`).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Basic ${basic}` },
      payload: { userId: "basic_user", event: "basic_auth_ok" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects malformed Basic credentials", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: "Basic !!!not-base64!!!" },
      payload: { userId: "basic_user", event: "basic_auth_bad" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /v1/batch", () => {
  it("processes a mixed batch and reports per-item errors", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { authorization: `Bearer ${secretKey}` },
      payload: {
        batch: [
          { type: "identify", userId: "batch_user_1", traits: { email: "b1@example.com" } },
          { type: "track", userId: "batch_user_1", event: "batch_track_ok" },
          { type: "track", event: "batch_anonymous" }, // no userId: rejected
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.received).toBe(2);
    expect(body.errors.length).toBe(1);
    expect(body.errors[0].index).toBe(2);

    const rows = await db.execute(
      sql`SELECT event_name FROM events WHERE tenant_id = ${tenantId} AND event_name = 'batch_track_ok'`,
    );
    expect(rows.rows.length).toBe(1);
    await app.close();
  });

  it("answers 503 when an item cannot be stored, so the sender retries; the failure is an ops event", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/batch",
        headers: { authorization: `Bearer ${secretKey}` },
        payload: {
          batch: [
            { type: "track", userId: "batch_503", event: "stored_before_failure", messageId: "b503-1" },
            // Postgres refuses a NUL byte in text: valid JSON, fails while being stored.
            { type: "track", userId: "batch_503", event: "bad\u0000name", messageId: "b503-2" },
            { type: "track", userId: "batch_503", event: "after_failure", messageId: "b503-3" },
          ],
        },
      });
    const res = await send();
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.received).toBe(1);
    expect(body.errors[0].index).toBe(1);

    // The item after the failure was not attempted; the resend stores nothing twice.
    await send();
    const rows = await db.execute(
      sql`SELECT message_id FROM events WHERE tenant_id = ${tenantId} AND message_id LIKE 'b503-%' ORDER BY message_id`,
    );
    expect(rows.rows.map((r) => r.message_id)).toEqual(["b503-1"]);

    const ops = await db.execute(
      sql`SELECT kind, severity, context FROM ops_events WHERE tenant_id = ${tenantId} AND kind = 'ingest_failed' AND severity = 'error'`,
    );
    expect(ops.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ops.rows[0]!.context)).toContain("b503-2");
    await app.close();
  });

  it("records invalid items as an ops warning", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { batch: [{ type: "track", event: "no_user_id_here" }] },
    });
    expect(res.statusCode).toBe(200);
    const ops = await db.execute(
      sql`SELECT context FROM ops_events WHERE tenant_id = ${tenantId} AND kind = 'ingest_failed' AND severity = 'warning'`,
    );
    expect(JSON.stringify(ops.rows.map((r) => r.context))).toContain("no_user_id_here");
    await app.close();
  });

  it("deduplicates items by messageId within and across batches", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const first = await app.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { authorization: `Bearer ${secretKey}` },
      payload: {
        batch: [{ type: "track", userId: "batch_dedup", event: "dedup_evt", messageId: "m-1" }],
      },
    });
    expect(JSON.parse(first.body).received).toBe(1);
    const second = await app.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { authorization: `Bearer ${secretKey}` },
      payload: {
        batch: [{ type: "track", userId: "batch_dedup", event: "dedup_evt", messageId: "m-1" }],
      },
    });
    // Deduped items are accepted (idempotent) but not re-inserted
    expect(JSON.parse(second.body).received).toBe(1);
    const rows = await db.execute(
      sql`SELECT id FROM events WHERE tenant_id = ${tenantId} AND message_id = 'm-1'`,
    );
    expect(rows.rows.length).toBe(1);
    await app.close();
  });

  it("rejects an invalid envelope", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { batch: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("OPTIONS /v1/batch answers preflight", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/batch",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    await app.close();
  });
});

describe("rate limiting", () => {
  it("publishable key: 301st request in a window gets 429 + Retry-After", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db });
    // Fresh key so no other test consumed its window
    const limited = await insertKey("publishable", null);
    let lastStatus = 0;
    let retryAfter: string | undefined;
    let acao: string | undefined;
    for (let i = 0; i < 301; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${limited}`, origin: ORIGIN },
        payload: { userId: "rl_user", event: "rl_probe" },
      });
      lastStatus = res.statusCode;
      retryAfter = res.headers["retry-after"] as string | undefined;
      acao = res.headers["access-control-allow-origin"] as string | undefined;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    // The 429 is readable cross-origin so browser clients can back off
    expect(acao).toBe(ORIGIN);
    await app.close();
  }, 60000);
});
