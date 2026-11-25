/**
 * Integration tests for the LLM settings endpoints.
 *
 * Coverage:
 *
 * PUT /v1/settings/llm:
 *   - Provider + key is enough: base_url and model default per provider and
 *     are stored as the effective values.
 *   - Overrides win: an explicit base_url/model is stored verbatim.
 *   - The key is verified against the provider before storing; a rejected key
 *     returns 422 with the provider's own message and stores nothing.
 *   - An unreachable endpoint returns 422 and stores nothing.
 *   - A custom endpoint requires base_url and model (no defaults exist).
 *   - A hosted provider requires an API key; ollama may be keyless.
 *   - Stored value is encrypted and decrypts to the effective config.
 *   - Read-back (GET) exposes the effective model/base_url/embedding_model
 *     but never the api_key in any form.
 *   - Updating replaces the active row; only one active row per tenant.
 *   - Another tenant's configuration is unreachable (tenant isolation).
 *   - Unknown provider is rejected with 400.
 *   - Missing ENCRYPTION_KEY returns 503.
 *
 * GET /v1/settings/llm:
 *   - Returns null when no config exists.
 *   - Returns the effective non-secret values; never the api_key.
 *   - Cross-tenant: tenant A cannot see tenant B's config.
 *
 * Verification is exercised against a local stub of the OpenAI-compatible
 * /chat/completions shape (node:http, no external network). The stub rejects
 * Bearer sk-bad-* with a 401 body shaped like a real provider error.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  llmConfigs,
} from "@claros/db/schema";
import { decrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[settings-llm.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

// Hardcoded 32-byte all-zeros test key. Never used in production.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_API_KEY = "sk-test_settings_llm_key_do_not_use";
const TEST_BAD_KEY = "sk-bad_settings_llm_key";
const TEST_MODEL = "gpt-4o";
const TEST_EMBEDDING_MODEL = "text-embedding-3-small";

const SLUG_A = "test-settings-llm-a";
const SLUG_B = "test-settings-llm-b";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let tenantBId: string;
let cookieA: string;
let cookieB: string;

// Saved env keys - restored after tests
let savedEncryptionKey: string | undefined;

// ---------------------------------------------------------------------------
// Stub OpenAI-compatible provider
// ---------------------------------------------------------------------------

let stub: Server;
let stubBaseUrl: string;

const STUB_401_BODY = JSON.stringify({
  error: {
    message: "Incorrect API key provided: sk-bad*****key. You can find your API key at https://platform.example.com/account/api-keys.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;

  // Stub provider: 401 for keys starting with sk-bad, 200 otherwise.
  stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const auth = req.headers.authorization ?? "";
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (auth.startsWith("Bearer sk-bad")) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(STUB_401_BODY);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  stubBaseUrl = `http://127.0.0.1:${port}/v1`;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[settings-llm.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[settings-llm.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();
  await setupTenants();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

// Clean llm configs between each test
beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenant_daily_usage WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

async function setupTenants() {
  const [tA] = await db
    .insert(tenants)
    .values({ name: "LLM Settings Test A", slug: SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@settings-llm.test", role: "owner" })
    .returning({ id: users.id });
  const [sA] = await db
    .insert(sessions)
    .values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieA = `claros_session=${sA!.id}`;

  const [tB] = await db
    .insert(tenants)
    .values({ name: "LLM Settings Test B", slug: SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@settings-llm.test", role: "owner" })
    .returning({ id: users.id });
  const [sB] = await db
    .insert(sessions)
    .values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieB = `claros_session=${sB!.id}`;
}

async function readActiveEnvelope(tenantId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ config: llmConfigs.config })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
    .limit(1);
  expect(rows).toHaveLength(1);
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  return JSON.parse(decrypt(rows[0]!.config, key)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PUT /v1/settings/llm
// ---------------------------------------------------------------------------

describe("PUT /v1/settings/llm", () => {
  it("provider + key is enough: defaults are applied and stored as effective values", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        // base_url overridden to the stub so verification stays local;
        // model left to the product default.
        base_url: stubBaseUrl,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verification).toEqual({ ok: true });
    expect(body.llm.provider).toBe("openai");
    expect(body.llm.model).toBe("gpt-4o-mini");
    expect(body.llm.base_url).toBe(stubBaseUrl);
    expect(body.llm.embedding_model).toBe("text-embedding-3-small");
    expect(body.llm.is_active).toBe(true);

    // No key material in the response.
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);

    const creds = await readActiveEnvelope(tenantAId);
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.baseUrl).toBe(stubBaseUrl);
    expect(creds.model).toBe("gpt-4o-mini");
    // Not overridden, so absent from the envelope (resolver default applies).
    expect(creds.embedding_model).toBeUndefined();
  });

  it("explicit model/base_url overrides are stored verbatim", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: stubBaseUrl,
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.llm.model).toBe(TEST_MODEL);
    expect(body.llm.base_url).toBe(stubBaseUrl);
    expect(body.llm.embedding_model).toBe(TEST_EMBEDDING_MODEL);

    const creds = await readActiveEnvelope(tenantAId);
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.baseUrl).toBe(stubBaseUrl);
    expect(creds.model).toBe(TEST_MODEL);
    expect(creds.embedding_model).toBe(TEST_EMBEDDING_MODEL);
  });

  it("a rejected key returns 422 with the provider's message and stores nothing", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_BAD_KEY,
        base_url: stubBaseUrl,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.verification.ok).toBe(false);
    expect(body.verification.kind).toBe("http");
    expect(body.verification.status).toBe(401);
    expect(body.error).toContain("rejected the credentials (HTTP 401)");
    expect(body.error).toContain("Incorrect API key provided");
    expect(body.error).toContain("Nothing was stored.");

    const rows = await db
      .select({ id: llmConfigs.id })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)));
    expect(rows).toHaveLength(0);
  });

  it("an unreachable endpoint returns 422 and stores nothing", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "custom",
        api_key: TEST_API_KEY,
        base_url: "http://127.0.0.1:1/v1",
        model: "any-model",
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.verification.ok).toBe(false);
    expect(body.verification.kind).toBe("unreachable");
    expect(body.error).toContain("could not be reached");
    expect(body.error).toContain("Nothing was stored.");

    const rows = await db
      .select({ id: llmConfigs.id })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)));
    expect(rows).toHaveLength(0);
  });

  it("custom provider without base_url or model returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const noBase = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "custom", api_key: TEST_API_KEY, model: "m" },
    });
    expect(noBase.statusCode).toBe(400);
    expect(noBase.json().error).toMatch(/base URL is required/i);

    const noModel = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "custom", api_key: TEST_API_KEY, base_url: stubBaseUrl },
    });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().error).toMatch(/model is required/i);
  });

  it("ollama may be saved without an API key; openai may not", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const ollama = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "ollama", base_url: stubBaseUrl },
    });
    expect(ollama.statusCode).toBe(200);
    expect(ollama.json().llm.model).toBe("llama3");
    const creds = await readActiveEnvelope(tenantAId);
    expect(creds.apiKey).toBe("");

    const openai = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "openai", base_url: stubBaseUrl },
    });
    expect(openai.statusCode).toBe(400);
    expect(openai.json().error).toMatch(/API key is required/i);
  });

  it("GET after PUT returns the effective values and never the api_key", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: stubBaseUrl,
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.llm).not.toBeNull();
    const bodyStr = JSON.stringify(body);

    // The key must never appear, in any form.
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(body.llm.api_key).toBeUndefined();
    expect(body.llm.config).toBeUndefined();

    // The effective non-secret values are shown so the dashboard can render
    // what the install will actually use.
    expect(body.llm.model).toBe(TEST_MODEL);
    expect(body.llm.base_url).toBe(stubBaseUrl);
    expect(body.llm.embedding_model).toBe(TEST_EMBEDDING_MODEL);
    expect(body.llm.provider).toBe("openai");
    expect(body.llm.is_active).toBe(true);
    expect(body.llm.created_at).toBeDefined();
  });

  it("updating replaces the active row; only one active row per tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // First write
    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: "sk-original",
        base_url: stubBaseUrl,
        model: "gpt-3.5-turbo",
      },
    });

    // Second write - different model
    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: stubBaseUrl,
        model: TEST_MODEL,
      },
    });

    // Exactly one active row
    const activeRows = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM llm_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
    `);
    expect(parseInt(activeRows.rows[0]!.cnt, 10)).toBe(1);

    const creds = await readActiveEnvelope(tenantAId);
    expect(creds.model).toBe(TEST_MODEL);
  });

  it("unknown provider returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "cohere", api_key: "key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown provider/i);
  });

  it("missing ENCRYPTION_KEY returns 503", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/settings/llm",
        headers: { cookie: cookieA, "content-type": "application/json" },
        payload: { provider: "openai", api_key: "key", base_url: stubBaseUrl },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/ENCRYPTION_KEY/);
    } finally {
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    }
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { "content-type": "application/json" },
      payload: { provider: "openai", api_key: "key", base_url: stubBaseUrl },
    });
    expect(res.statusCode).toBe(401);
  });

  it("config written via PUT resolves through the shared encrypt/decrypt path", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { provider: "openai", api_key: TEST_API_KEY, base_url: stubBaseUrl },
    });
    expect(putRes.statusCode).toBe(200);

    // Same parseEncryptionKey + decrypt from @claros/adapters that
    // resolveTenantProvider uses at runtime.
    const creds = await readActiveEnvelope(tenantAId);
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.baseUrl).toBe(stubBaseUrl);
    expect(creds.model).toBe("gpt-4o-mini");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/settings/llm
// ---------------------------------------------------------------------------

describe("GET /v1/settings/llm", () => {
  it("returns null when no config exists", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().llm).toBeNull();
  });

  it("returns effective values for a directly-inserted config, never the key", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Insert directly using the same encrypt path the endpoint uses
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const { encrypt: encryptFn } = await import("@claros/adapters");
    const encryptedConfig = encryptFn(
      JSON.stringify({
        apiKey: TEST_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      }),
      key,
    );
    await db.insert(llmConfigs).values({
      tenantId: tenantAId,
      provider: "openai",
      config: encryptedConfig,
      isActive: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const l = body.llm;
    expect(l).not.toBeNull();

    expect(l.provider).toBe("openai");
    expect(l.model).toBe(TEST_MODEL);
    expect(l.base_url).toBe("https://api.openai.com/v1");
    expect(l.embedding_model).toBe(TEST_EMBEDDING_MODEL);

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(l.api_key).toBeUndefined();
    expect(l.config).toBeUndefined();
  });

  it("a config written without an explicit model reports nulls, not a failure", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Pre-change envelope shape is impossible (model was always required),
    // but a hand-edited envelope must not break the settings screen.
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const { encrypt: encryptFn } = await import("@claros/adapters");
    const encryptedConfig = encryptFn(
      JSON.stringify({ apiKey: TEST_API_KEY }),
      key,
    );
    await db.insert(llmConfigs).values({
      tenantId: tenantAId,
      provider: "custom",
      config: encryptedConfig,
      isActive: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const l = res.json().llm;
    expect(l.provider).toBe("custom");
    expect(l.model).toBeNull();
    expect(l.base_url).toBeNull();
    expect(JSON.stringify(res.json())).not.toContain(TEST_API_KEY);
  });

  it("tenant isolation: tenant B cannot see tenant A config", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const { encrypt: encryptFn } = await import("@claros/adapters");
    const encryptedConfig = encryptFn(
      JSON.stringify({ apiKey: TEST_API_KEY, baseUrl: stubBaseUrl, model: TEST_MODEL }),
      key,
    );
    await db.insert(llmConfigs).values({
      tenantId: tenantAId,
      provider: "openai",
      config: encryptedConfig,
      isActive: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().llm).toBeNull();
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
    });
    expect(res.statusCode).toBe(401);
  });
});
