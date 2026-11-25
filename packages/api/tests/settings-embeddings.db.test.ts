/**
 * Integration tests for the embedding provider settings endpoints.
 *
 * Coverage:
 *   PUT /v1/settings/embeddings
 *     - verifies with one embedding call before storing; stores the effective
 *       config encrypted, with sendDimensions true when `dimensions` was accepted
 *     - an endpoint that rejects `dimensions` (400) is retried without it
 *     - a model that answers another size is refused (422), nothing stored
 *     - a rejected key is refused (422) with the provider's message
 *     - Anthropic is not an embedding provider (400 that says why)
 *     - custom requires base_url and model
 *     - a model change drops stored vectors and enqueues re-embedding
 *   GET /v1/settings/embeddings
 *     - null with an Anthropic LLM only; llm_config with an OpenAI LLM;
 *       embedding_config once saved; never the api_key; tenant-scoped
 *   DELETE /v1/settings/embeddings
 *     - removes the saved provider; with no fallback, entries become skipped
 *
 * The provider is a local node:http stub of POST /v1/embeddings (no network).
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, embeddingConfigs, llmConfigs, kbEntries } from "@claros/db/schema";
import { decrypt, encrypt, parseEncryptionKey } from "@claros/adapters";
import { QUEUE } from "@claros/core";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[settings-embeddings.test] DATABASE_URL is not set (see .env.example).");
}

// Hardcoded 32-byte all-zeros test key. Never used in production.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_API_KEY = "sk-test_settings_embeddings_do_not_use";
const SLUG_A = "test-settings-emb-a";
const SLUG_B = "test-settings-emb-b";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantAId: string;
let tenantBId: string;
let cookieA: string;
let cookieB: string;
let savedEncryptionKey: string | undefined;

let stub: Server;
let stubBaseUrl: string;
/** Request bodies the stub received, in order. */
let received: Array<Record<string, unknown>> = [];

const vector = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;

  // Stub: 401 for sk-bad keys; model "no-dims" rejects the dimensions
  // parameter with 400; model "size-768" answers 768 components; else 1536.
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push(body);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if ((req.headers.authorization ?? "").startsWith("Bearer sk-bad")) {
        send(401, { error: { message: "Incorrect API key provided." } });
      } else if (body.model === "no-dims" && "dimensions" in body) {
        send(400, { error: { message: "This model does not support specifying dimensions." } });
      } else {
        send(200, { data: [{ embedding: vector(body.model === "size-768" ? 768 : 1536) }] });
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubBaseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[settings-embeddings.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  ({ tenantId: tenantAId, cookie: cookieA } = await setupTenant(SLUG_A));
  ({ tenantId: tenantBId, cookie: cookieB } = await setupTenant(SLUG_B));
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (savedEncryptionKey !== undefined) process.env.ENCRYPTION_KEY = savedEncryptionKey;
  else delete process.env.ENCRYPTION_KEY;
});

beforeEach(async () => {
  received = [];
  if (!dbAvailable) return;
  for (const t of [tenantAId, tenantBId]) {
    await db.execute(sql`DELETE FROM embedding_configs WHERE tenant_id = ${t}::uuid`);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${t}::uuid`);
    await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id = ${t}::uuid`);
  }
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    const inTenant = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    await db.execute(sql`DELETE FROM embedding_configs WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM tenant_daily_usage WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN ${inTenant}`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

async function setupTenant(slug: string): Promise<{ tenantId: string; cookie: string }> {
  const [t] = await db.insert(tenants).values({ name: slug, slug, plan: "free" }).returning({ id: tenants.id });
  const [u] = await db
    .insert(users)
    .values({ tenantId: t!.id, email: `owner@${slug}.test`, role: "owner" })
    .returning({ id: users.id });
  const [s] = await db
    .insert(sessions)
    .values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  return { tenantId: t!.id, cookie: `claros_session=${s!.id}` };
}

async function writeLlm(tenantId: string, provider: string, baseUrl: string) {
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  await db.insert(llmConfigs).values({
    tenantId,
    provider,
    config: encrypt(JSON.stringify({ apiKey: "k", baseUrl, model: "m" }), key),
  });
}

async function activeEnvelope(tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ config: embeddingConfigs.config })
    .from(embeddingConfigs)
    .where(and(eq(embeddingConfigs.tenantId, tenantId), eq(embeddingConfigs.isActive, true)));
  if (rows.length === 0) return null;
  expect(rows).toHaveLength(1);
  return JSON.parse(decrypt(rows[0]!.config, parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64))) as Record<string, unknown>;
}

async function put(cookie: string, payload: Record<string, unknown>, enqueue?: ReturnType<typeof vi.fn>) {
  const app = await buildApp({ db, logger: false, ...(enqueue ? { enqueue } : {}) });
  return app.inject({
    method: "PUT",
    url: "/v1/settings/embeddings",
    headers: { cookie, "content-type": "application/json" },
    payload,
  });
}

async function get(cookie: string) {
  const app = await buildApp({ db, logger: false });
  return app.inject({ method: "GET", url: "/v1/settings/embeddings", headers: { cookie } });
}

describe("PUT /v1/settings/embeddings", () => {
  it("verifies, then stores the effective config encrypted; dimensions accepted", async () => {
    if (!dbAvailable) return;
    const res = await put(cookieA, { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verification).toEqual({ ok: true });
    expect(body.embeddings).toMatchObject({
      source: "embedding_config",
      provider: "openai",
      base_url: stubBaseUrl,
      model: "text-embedding-3-small",
      dimensions: 1536,
      sends_dimensions: true,
    });
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(received[0]).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536 });
    expect(await activeEnvelope(tenantAId)).toEqual({
      apiKey: TEST_API_KEY,
      baseUrl: stubBaseUrl,
      model: "text-embedding-3-small",
      sendDimensions: true,
    });
  });

  it("retries without dimensions when the endpoint rejects the parameter", async () => {
    if (!dbAvailable) return;
    const res = await put(cookieA, { provider: "custom", base_url: stubBaseUrl, model: "no-dims" });
    expect(res.statusCode).toBe(200);
    expect(received).toHaveLength(2);
    expect("dimensions" in received[1]!).toBe(false);
    expect((await activeEnvelope(tenantAId))!.sendDimensions).toBe(false);
  });

  it("refuses a model that answers another size; nothing stored", async () => {
    if (!dbAvailable) return;
    const res = await put(cookieA, { provider: "custom", base_url: stubBaseUrl, model: "size-768" });
    expect(res.statusCode).toBe(422);
    expect(res.json().verification.kind).toBe("dimensions");
    expect(res.json().error).toMatch(/768 dimensions/);
    expect(await activeEnvelope(tenantAId)).toBeNull();
  });

  it("refuses a rejected key with the provider's message; nothing stored", async () => {
    if (!dbAvailable) return;
    const res = await put(cookieA, { provider: "openai", api_key: "sk-bad-key", base_url: stubBaseUrl });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/HTTP 401.*Incorrect API key/);
    expect(await activeEnvelope(tenantAId)).toBeNull();
  });

  it("Anthropic is not an embedding provider: 400 that says why", async () => {
    if (!dbAvailable) return;
    const res = await put(cookieA, { provider: "anthropic", api_key: TEST_API_KEY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Anthropic has no embeddings API/);
  });

  it("custom requires base_url and model; openai requires a key", async () => {
    if (!dbAvailable) return;
    expect((await put(cookieA, { provider: "custom", model: "m" })).json().error).toMatch(/base URL is required/);
    expect((await put(cookieA, { provider: "custom", base_url: stubBaseUrl })).json().error).toMatch(/model is required/);
    expect((await put(cookieA, { provider: "openai" })).json().error).toMatch(/API key is required/);
    expect(received).toHaveLength(0);
  });

  it("a model change drops stored vectors and enqueues re-embedding", async () => {
    if (!dbAvailable) return;
    const [embedded] = await db
      .insert(kbEntries)
      .values({ tenantId: tenantAId, title: "Pricing", content: "Plans", embedding: vector(1536) })
      .returning({ id: kbEntries.id });
    const [skipped] = await db
      .insert(kbEntries)
      .values({ tenantId: tenantAId, title: "Quota", content: "Quota", embeddingStatus: "skipped" })
      .returning({ id: kbEntries.id });
    const enqueue = vi.fn().mockResolvedValue("job");

    const res = await put(cookieA, { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl }, enqueue);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vectors_cleared: true, reembed: { enqueued: 2, remaining: 0 } });
    const queued = enqueue.mock.calls.map((c) => [c[0], (c[1] as { kb_entry_id: string }).kb_entry_id]);
    expect(queued.sort()).toEqual([[QUEUE.KB_EMBED, embedded!.id], [QUEUE.KB_EMBED, skipped!.id]].sort());
    const rows = await db.select().from(kbEntries).where(eq(kbEntries.tenantId, tenantAId));
    for (const r of rows) expect(r).toMatchObject({ embedding: null, embeddingStatus: "pending" });

    // Same endpoint, model and dimensions again (key rotation): vectors kept.
    await db.update(kbEntries).set({ embedding: vector(1536), embeddingStatus: null }).where(eq(kbEntries.id, embedded!.id));
    const again = await put(cookieA, { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl }, vi.fn().mockResolvedValue("job"));
    expect(again.json().vectors_cleared).toBe(false);
    const [kept] = await db.select().from(kbEntries).where(eq(kbEntries.id, embedded!.id));
    expect(kept!.embedding).not.toBeNull();
  });
});

describe("GET /v1/settings/embeddings", () => {
  it("null with an Anthropic LLM only; llm_config with an OpenAI LLM", async () => {
    if (!dbAvailable) return;
    await writeLlm(tenantAId, "anthropic", "https://api.anthropic.com/v1");
    expect((await get(cookieA)).json()).toEqual({ embeddings: null });

    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${tenantAId}::uuid`);
    await writeLlm(tenantAId, "openai", "https://api.openai.com/v1");
    expect((await get(cookieA)).json().embeddings).toMatchObject({
      source: "llm_config",
      provider: "openai",
      model: "text-embedding-3-small",
      sends_dimensions: false,
    });
  });

  it("is tenant-scoped and never returns the key", async () => {
    if (!dbAvailable) return;
    await put(cookieA, { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl });
    const a = await get(cookieA);
    expect(a.json().embeddings.source).toBe("embedding_config");
    expect(a.body).not.toContain(TEST_API_KEY);
    expect((await get(cookieB)).json()).toEqual({ embeddings: null });
  });
});

describe("DELETE /v1/settings/embeddings", () => {
  it("removes the saved provider; with no fallback, entries become skipped", async () => {
    if (!dbAvailable) return;
    await writeLlm(tenantAId, "anthropic", "https://api.anthropic.com/v1");
    await put(cookieA, { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl });
    await db.insert(kbEntries).values({ tenantId: tenantAId, title: "Pricing", content: "Plans", embedding: vector(1536) });

    const app = await buildApp({ db, logger: false, enqueue: vi.fn().mockResolvedValue("job") });
    const res = await app.inject({ method: "DELETE", url: "/v1/settings/embeddings", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ embeddings: null, vectors_cleared: true, reembed: null });
    expect(await activeEnvelope(tenantAId)).toBeNull();
    const [row] = await db.select().from(kbEntries).where(eq(kbEntries.tenantId, tenantAId));
    expect(row).toMatchObject({ embedding: null, embeddingStatus: "skipped" });
  });
});
