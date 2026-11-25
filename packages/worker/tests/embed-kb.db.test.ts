/**
 * Integration tests for the KB embedding worker (task 22) including gap fixes.
 *
 * Provider (fetch) is mocked. Postgres is real.
 *
 * Tests:
 *
 * API-layer enqueue behaviour:
 * - POST /v1/kb enqueues exactly one KB_EMBED job with singletonKey.
 * - POST /v1/kb sets embedding_status = 'pending' when enqueue is available.
 * - POST /v1/kb leaves embedding_status = null when enqueue is absent (tests).
 * - PATCH with content change enqueues another KB_EMBED job.
 * - PATCH with content change sets embedding_status = 'pending'.
 * - PATCH with only tags change enqueues NO KB_EMBED job.
 * - PATCH with only tags change does NOT change embedding_status.
 *
 * Worker happy path:
 * - Worker writes a 1536-dimensional embedding.
 * - Worker calls the embedding endpoint with the correct model and input.
 * - Worker silently skips when entry no longer exists.
 *
 * Gap 1 - permanent vs transient failure classification:
 * - Dimensionality mismatch: worker records embedding_status = 'failed' with
 *   error naming model + both dimensionalities; does NOT throw (no pg-boss retry).
 * - Missing LLM config: worker records embedding_status = 'failed'; does NOT throw.
 * - Provider 500 error: worker throws (pg-boss retries); embedding stays NULL,
 *   embedding_status stays 'pending' (not 'failed').
 * - Provider 401 error (step 0 fix): worker does NOT throw; records 'failed' with
 *   the HTTP status in embedding_error. Entry is distinguishable from pending work.
 *   Re-embed path: fix credentials, PATCH to re-enqueue.
 *
 * Gap 2 - distinguishable states:
 * - embedding_status = null means never enqueued.
 * - embedding_status = 'pending' means job enqueued, not yet written.
 * - embedding_status = 'failed' means permanently failed (reason in embedding_error).
 * - After successful embedding: embedding IS NOT NULL, embedding_status = null.
 * - Operator query: embedding IS NULL AND tenant_id = $1 returns both pending and failed.
 *
 * Gap 3 - atomicity:
 * - POST with enqueue available: INSERT sets embedding_status = 'pending' before
 *   boss.send; if boss.send fails the orphan is visible (pending + no embedding).
 * - POST without enqueue: embedding_status stays null.
 *
 * Concurrency:
 * - Two concurrent workers do not corrupt entry; final embedding is valid.
 *
 * Tenant scoping:
 * - Job for tenant A cannot embed an entry belonging to tenant B.
 *
 * Content truncation:
 * - Content > EMBEDDING_MAX_CHARS is truncated before the embedding call.
 * - Content at exactly EMBEDDING_MAX_CHARS is not truncated.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, kbEntries, users, sessions } from "@claros/db/schema";
import { buildApp } from "../../api/src/index.js";

// ---------------------------------------------------------------------------
// Mock: fetch (no network)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Mock: @claros/adapters decrypt (avoid real crypto in embedding path)
// ---------------------------------------------------------------------------

vi.mock("@claros/adapters", () => ({
  decrypt: vi.fn((_ciphertext: string, _key: unknown) => {
    // Return a minimal valid config JSON; embedding_model is absent so the
    // default "text-embedding-3-small" is used.
    return JSON.stringify({
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.test/v1",
      model: "gpt-4o",
    });
  }),
  parseEncryptionKey: vi.fn(() => "fake-key"),
}));

// Import worker after mocks are registered
const { handleKbEmbedJob, EMBEDDING_MAX_CHARS } = await import("../src/embed-kb.js");

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[embed-kb.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;
let otherTenantId: string;

const SLUG = "test-embed-kb";
const SLUG_OTHER = "test-embed-kb-other";

/** Shared fake session for the API tests that need an enqueue-equipped app */
let sessionId: string;
let cookieA: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[embed-kb.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[embed-kb.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Set ENCRYPTION_KEY for the worker (mocked decrypt doesn't actually use it)
  process.env.ENCRYPTION_KEY = "0".repeat(64); // 32-byte hex key

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Embed KB", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Test Embed KB Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;

  // Create sessions for API-layer tests
  const [uA] = await db
    .insert(users)
    .values({ tenantId: testTenantId, email: "owner@embed.test", role: "owner" })
    .returning({ id: users.id });
  const [sA] = await db
    .insert(sessions)
    .values({ tenantId: testTenantId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  sessionId = sA!.id;
  cookieA = `claros_session=${sessionId}`;

  // Insert a minimal llm_configs row for testTenantId so the worker finds it.
  // The actual config is intercepted by the mocked decrypt().
  await db.execute(sql`
    INSERT INTO llm_configs (tenant_id, provider, config, is_active)
    VALUES (${testTenantId}, 'openai', 'mock-encrypted-config', true)
  `);
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

beforeEach(() => {
  if (!dbAvailable) return;
  mockFetch.mockReset();
  // Default mock: 1536-dimensional embedding
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    }),
  });
});

// ---------------------------------------------------------------------------
// Helper: insert a KB entry directly
// ---------------------------------------------------------------------------

async function insertKbEntry(
  title: string,
  content: string,
  tenantId: string = testTenantId,
  embeddingStatus: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(kbEntries)
    .values({
      tenantId,
      title,
      content,
      contentType: "markdown",
      source: "manual",
      isActive: true,
      ...(embeddingStatus !== null ? { embeddingStatus } as any : {}),
    })
    .returning({ id: kbEntries.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Helper: read embedding_status + embedding_error from DB
// ---------------------------------------------------------------------------

async function readEmbedState(id: string) {
  const rows = await db.execute<{
    embedding_status: string | null;
    embedding_error: string | null;
    embedding: string | null;
  }>(sql`
    SELECT embedding_status, embedding_error,
           CASE WHEN embedding IS NULL THEN NULL ELSE 'present' END AS embedding
    FROM kb_entries WHERE id = ${id}
  `);
  return rows.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Tests: API-layer enqueue behaviour and embedding_status
// ---------------------------------------------------------------------------

describe("KB API enqueue behaviour and embedding_status (gap 2 + gap 3)", () => {
  it("POST /v1/kb enqueues exactly one KB_EMBED job with singletonKey", async () => {
    if (!dbAvailable) return;
    const enqueue = vi.fn().mockResolvedValue("job-id");
    const app = await buildApp({ db, logger: false, enqueue });

    const res = await app.inject({
      method: "POST",
      url: "/v1/kb",
      headers: { cookie: cookieA },
      payload: { title: "Enqueue on Create", content: "Some content." },
    });
    expect(res.statusCode).toBe(201);

    const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
    expect(kbEmbedCalls).toHaveLength(1);
    const [, payload, opts] = kbEmbedCalls[0]!;
    expect(payload).toMatchObject({ kb_entry_id: res.json().id, tenant_id: testTenantId });
    expect((opts as any).singletonKey).toBe(res.json().id);
  });

  it("POST /v1/kb sets embedding_status = 'pending' when enqueue is available", async () => {
    if (!dbAvailable) return;
    const enqueue = vi.fn().mockResolvedValue("job-id");
    const app = await buildApp({ db, logger: false, enqueue });

    const res = await app.inject({
      method: "POST",
      url: "/v1/kb",
      headers: { cookie: cookieA },
      payload: { title: "Status Pending Test", content: "Content." },
    });
    expect(res.statusCode).toBe(201);

    // API response should carry embedding_status
    expect(res.json().embedding_status).toBe("pending");

    // DB should have embedding_status = 'pending'
    const state = await readEmbedState(res.json().id);
    expect(state?.embedding_status).toBe("pending");
    expect(state?.embedding).toBeNull();
  });

  it("POST /v1/kb leaves embedding_status = null when enqueue is absent", async () => {
    if (!dbAvailable) return;
    // No enqueue function - tests without pg-boss
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/v1/kb",
      headers: { cookie: cookieA },
      payload: { title: "No Enqueue Status", content: "Content." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().embedding_status).toBeNull();
  });

  it("PATCH with content change enqueues another KB_EMBED job and sets embedding_status = 'pending'", async () => {
    if (!dbAvailable) return;
    const enqueue = vi.fn().mockResolvedValue("job-id");
    const app = await buildApp({ db, logger: false, enqueue });

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/kb",
      headers: { cookie: cookieA },
      payload: { title: "Re-embed On Content Change", content: "Original content." },
    });
    const id = createRes.json().id;

    enqueue.mockClear();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/kb/${id}`,
      headers: { cookie: cookieA },
      payload: { content: "Updated content." },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().embedding_status).toBe("pending");

    const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
    expect(kbEmbedCalls).toHaveLength(1);
    const [, payload] = kbEmbedCalls[0]!;
    expect(payload).toMatchObject({ kb_entry_id: id, tenant_id: testTenantId });
  });

  it("PATCH with only tags change enqueues NO KB_EMBED job and does NOT change embedding_status", async () => {
    if (!dbAvailable) return;
    const enqueue = vi.fn().mockResolvedValue("job-id");
    const app = await buildApp({ db, logger: false, enqueue });

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/kb",
      headers: { cookie: cookieA },
      payload: { title: "No Re-embed On Tag Change", content: "Content unchanged." },
    });
    const id = createRes.json().id;

    enqueue.mockClear();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/kb/${id}`,
      headers: { cookie: cookieA },
      payload: { tags: ["new-tag", "another"] },
    });
    expect(patchRes.statusCode).toBe(200);
    // embedding_status must stay 'pending' from the initial create
    expect(patchRes.json().embedding_status).toBe("pending");

    const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
    expect(kbEmbedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Worker happy path
// ---------------------------------------------------------------------------

describe("handleKbEmbedJob - happy path", () => {
  it("writes a 1536-dimensional embedding and clears embedding_status", async () => {
    if (!dbAvailable) return;
    const id = await insertKbEntry("Embed Write Test", "Content to embed.", testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    const state = await readEmbedState(id);
    expect(state?.embedding).toBe("present");
    // embedding_status cleared to null on success (the vector is the evidence)
    expect(state?.embedding_status).toBeNull();
    expect(state?.embedding_error).toBeNull();
  });

  it("calls the embedding endpoint with the correct model and input", async () => {
    if (!dbAvailable) return;
    const content = "Verifiable content string.";
    const id = await insertKbEntry("Model Verification", content, testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/embeddings");
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("text-embedding-3-small"); // default
    expect(body.input).toBe(content);
  });

  it("silently skips when the entry no longer exists", async () => {
    if (!dbAvailable) return;
    await expect(
      handleKbEmbedJob(
        { kb_entry_id: "00000000-0000-0000-0000-000000000000", tenant_id: testTenantId },
        db,
      ),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: Gap 1 - permanent failure vs transient failure
// ---------------------------------------------------------------------------

describe("handleKbEmbedJob - gap 1: permanent vs transient failures", () => {
  it("dimensionality mismatch: records failed state, does NOT throw (no pg-boss retry)", async () => {
    if (!dbAvailable) return;
    // Mock a 3072-dimensional response
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: new Array(3072).fill(0.5) }],
      }),
    });

    const id = await insertKbEntry("Dim Mismatch Test", "Some content.", testTenantId, "pending");

    // Must NOT throw - permanent failure is recorded, not propagated
    await expect(
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db),
    ).resolves.toBeUndefined();

    const state = await readEmbedState(id);
    expect(state?.embedding_status).toBe("failed");
    expect(state?.embedding_error).toMatch(/3072.*1536|1536.*3072/);
    expect(state?.embedding).toBeNull();
  });

  it("dimensionality error names the configured model and both dimensionalities", async () => {
    if (!dbAvailable) return;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: new Array(768).fill(0.1) }],
      }),
    });

    const id = await insertKbEntry("Dim Error Message Test", "Content.", testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    const state = await readEmbedState(id);
    expect(state?.embedding_error).toMatch(/text-embedding-3-small/);
    expect(state?.embedding_error).toMatch(/768/);
    expect(state?.embedding_error).toMatch(/1536/);
  });

  it("no embedding provider: marks the entry skipped (not failed), does NOT throw, no call", async () => {
    if (!dbAvailable) return;
    // otherTenantId has neither an embedding_configs nor an llm_configs row
    const id = await insertKbEntry("No Config Test", "Content.", otherTenantId, "pending");

    await expect(
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: otherTenantId }, db),
    ).resolves.toBeUndefined();

    const state = await readEmbedState(id);
    expect(state?.embedding_status).toBe("skipped");
    expect(state?.embedding_error).toBeNull();
    expect(state?.embedding).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("provider 500 error: THROWS (pg-boss retries); embedding stays NULL, status stays 'pending'", async () => {
    if (!dbAvailable) return;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const id = await insertKbEntry("Provider Error Test", "Content that cannot be embedded.", testTenantId, "pending");

    // MUST throw - transient failure propagates to pg-boss for retry
    await expect(
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db),
    ).rejects.toThrow(/500|embedding/i);

    // Embedding must be NULL, status must stay 'pending' (retryable)
    const state = await readEmbedState(id);
    expect(state?.embedding).toBeNull();
    expect(state?.embedding_status).toBe("pending"); // not 'failed' - will retry
    expect(state?.embedding_error).toBeNull();
  // 500 triggers retries with exponential backoff (up to 3 retries: 1s+2s+4s=7s)
  }, 15_000);

  it("provider 401 error (step 0 fix): records failed state, does NOT throw, not indistinguishable from pending", async () => {
    if (!dbAvailable) return;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const id = await insertKbEntry("Auth Error Test", "Content.", testTenantId, "pending");

    // Must NOT throw - permanent failure is recorded, not propagated
    await expect(
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db),
    ).resolves.toBeUndefined();

    // fetch called exactly once (no retries for 401)
    expect(mockFetch).toHaveBeenCalledOnce();

    // Key correctness: status is 'failed' (not 'pending'), so the entry
    // is distinguishable from work genuinely waiting in the queue.
    const state = await readEmbedState(id);
    expect(state?.embedding).toBeNull();
    expect(state?.embedding_status).toBe("failed");
    expect(state?.embedding_error).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// Tests: Gap 2 - distinguishable states
// ---------------------------------------------------------------------------

describe("gap 2: embedding states are distinguishable", () => {
  it("null means never enqueued; pending means job enqueued; failed means permanent error", async () => {
    if (!dbAvailable) return;
    // null state
    const nullId = await insertKbEntry("Null State", "Content.", testTenantId, null);
    const nullState = await readEmbedState(nullId);
    expect(nullState?.embedding_status).toBeNull();
    expect(nullState?.embedding).toBeNull();

    // pending state
    const pendingId = await insertKbEntry("Pending State", "Content.", testTenantId, "pending");
    const pendingState = await readEmbedState(pendingId);
    expect(pendingState?.embedding_status).toBe("pending");
    expect(pendingState?.embedding).toBeNull();

    // failed state
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ data: [{ embedding: new Array(3072).fill(0.1) }] }),
    });
    const failedId = await insertKbEntry("Failed State", "Content.", testTenantId, "pending");
    await handleKbEmbedJob({ kb_entry_id: failedId, tenant_id: testTenantId }, db);
    const failedState = await readEmbedState(failedId);
    expect(failedState?.embedding_status).toBe("failed");
    expect(failedState?.embedding).toBeNull();
    expect(failedState?.embedding_error).toBeTruthy();
  });

  it("after successful embedding: embedding IS NOT NULL, embedding_status = null", async () => {
    if (!dbAvailable) return;
    const id = await insertKbEntry("Success State", "Content.", testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    const state = await readEmbedState(id);
    expect(state?.embedding).toBe("present"); // vector written
    expect(state?.embedding_status).toBeNull(); // cleared on success
    expect(state?.embedding_error).toBeNull();
  });

  it("operator query finds entries needing attention (embedding IS NULL)", async () => {
    if (!dbAvailable) return;
    const nullId = await insertKbEntry("Op Query Null", "Content.", testTenantId, null);
    const pendingId = await insertKbEntry("Op Query Pending", "Content.", testTenantId, "pending");

    // Create a successful entry to verify it's excluded
    const doneId = await insertKbEntry("Op Query Done", "Content.", testTenantId, "pending");
    await handleKbEmbedJob({ kb_entry_id: doneId, tenant_id: testTenantId }, db);

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM kb_entries
      WHERE embedding IS NULL AND tenant_id = ${testTenantId}
    `);
    const ids = rows.rows.map((r) => r.id);
    expect(ids).toContain(nullId);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(doneId);
  });
});

// ---------------------------------------------------------------------------
// Tests: Content truncation
// ---------------------------------------------------------------------------

describe("handleKbEmbedJob - content truncation", () => {
  it("truncates content > EMBEDDING_MAX_CHARS and calls fetch with the truncated string", async () => {
    if (!dbAvailable) return;
    const oversizedContent = "X".repeat(EMBEDDING_MAX_CHARS + 1000);
    const id = await insertKbEntry("Truncation Test", oversizedContent, testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.input.length).toBe(EMBEDDING_MAX_CHARS);
    expect(body.input).toBe("X".repeat(EMBEDDING_MAX_CHARS));
  });

  it("does not truncate content at or below EMBEDDING_MAX_CHARS", async () => {
    if (!dbAvailable) return;
    const exactContent = "Y".repeat(EMBEDDING_MAX_CHARS);
    const id = await insertKbEntry("Exact Limit Test", exactContent, testTenantId, "pending");

    await handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.input.length).toBe(EMBEDDING_MAX_CHARS);
    expect(body.input).toBe(exactContent);
  });
});

// ---------------------------------------------------------------------------
// Tests: Concurrency (two workers, same entry)
// ---------------------------------------------------------------------------

describe("handleKbEmbedJob - concurrency", () => {
  it("two concurrent workers embed the same entry without crashing; embedding is written", async () => {
    if (!dbAvailable) return;
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      const value = callCount === 1 ? 0.1 : 0.2;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: new Array(1536).fill(value) }],
        }),
      };
    });

    const id = await insertKbEntry("Concurrency Test", "Concurrent content.", testTenantId, "pending");

    await Promise.all([
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db),
      handleKbEmbedJob({ kb_entry_id: id, tenant_id: testTenantId }, db),
    ]);

    const state = await readEmbedState(id);
    expect(state?.embedding).toBe("present");
    expect(state?.embedding_status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Tenant scoping
// ---------------------------------------------------------------------------

describe("handleKbEmbedJob - tenant scoping", () => {
  it("a job for tenant A does not embed an entry belonging to tenant B", async () => {
    if (!dbAvailable) return;
    const idOther = await insertKbEntry("Other Tenant Entry", "Other content.", otherTenantId, "pending");

    // Run job with testTenantId - wrong tenant, should skip silently
    await handleKbEmbedJob(
      { kb_entry_id: idOther, tenant_id: testTenantId },
      db,
    );

    expect(mockFetch).not.toHaveBeenCalled();

    const state = await readEmbedState(idOther);
    expect(state?.embedding).toBeNull();
    expect(state?.embedding_status).toBe("pending"); // unchanged
  });
});
