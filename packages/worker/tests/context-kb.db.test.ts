/**
 * Integration tests for the KB context builder (KB search wiring).
 *
 * Not task 23 (auto-crawl). This tests the similarity search wiring that
 * constitutes the Phase 3 exit criteria.
 *
 * Tests:
 *
 * Happy path:
 * - Similarity search returns relevant entries ahead of irrelevant ones
 *   (verified by controlling mock embedding vectors to place relevant entries
 *   at higher cosine similarity than irrelevant ones).
 * - The similarity floor excludes weak matches.
 * - A kb_ref entry is always included even when its similarity would fall
 *   below the floor.
 * - Entries from another tenant never appear.
 * - A tenant with no embedded entries yields undefined (no KB context),
 *   not an error or an empty-looking section.
 *
 * Truncation integration:
 * - When kb_context is populated and the assembled context exceeds budget,
 *   kb_context is the first section dropped.
 *
 * Edge cases:
 * - Inactive entries (is_active=false) are excluded from results.
 * - Entries without embeddings are excluded from semantic results.
 * - When the explicit kb_ref is not found, similarity results fill all slots.
 *
 * Keyword fallback (no embedding provider, or a failed query embedding):
 * - Entries sharing enough non-stop words with the query are returned,
 *   embedded or not; kb_ref works without an embedding.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, kbEntries } from "@claros/db/schema";
import { applyBudgetTruncation } from "../src/context-budget.js";
import type { DraftPromptContext } from "@claros/brain-oss";

// ---------------------------------------------------------------------------
// Mock: fetch (no network) and @claros/adapters
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@claros/adapters", () => ({
  decrypt: vi.fn(() =>
    JSON.stringify({ apiKey: "sk-test", baseUrl: "https://api.test/v1", model: "gpt-4o" }),
  ),
  parseEncryptionKey: vi.fn(() => "fake-key"),
}));

// Import after mocks
const { buildKbContextSection, KB_MAX_RESULTS, KB_SIMILARITY_FLOOR } = await import(
  "../src/context-kb.js"
);

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[context-kb.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-ctx-kb";
const SLUG_OTHER = "test-ctx-kb-other";

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
        `[context-kb.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[context-kb.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  process.env.ENCRYPTION_KEY = "0".repeat(64);

  await cleanup();

  const [t1] = await db
    .insert(tenants)
    .values({ name: "KB Context Test", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = t1!.id;

  const [t2] = await db
    .insert(tenants)
    .values({ name: "KB Context Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = t2!.id;

  // Insert LLM config so resolveEmbeddingProvider succeeds
  await db.execute(sql`
    INSERT INTO llm_configs (tenant_id, provider, config, is_active)
    VALUES (${testTenantId}, 'openai', 'mock-config', true)
  `);
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

beforeEach(async () => {
  if (!dbAvailable) return;
  mockFetch.mockReset();
  // Clean KB entries between tests
  await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id = ${otherTenantId}`);
});

// ---------------------------------------------------------------------------
// Helpers: vector arithmetic
// ---------------------------------------------------------------------------

/**
 * Create a unit vector of length 1536 pointing mostly in direction `dims`.
 * dims is a small set of dimension indices that are set to 1/(sqrt(dims.length)),
 * everything else 0. Two vectors with the same dims have cosine similarity 1.
 * Two vectors with no shared dims have cosine similarity 0.
 */
function makeVector(dims: number[]): number[] {
  const v = new Array(1536).fill(0);
  const mag = 1 / Math.sqrt(dims.length);
  for (const d of dims) v[d] = mag;
  return v;
}

/** Format a vector as a pgvector literal for direct DB insertion. */
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Insert a KB entry with a pre-computed embedding for testing. */
async function insertEntryWithEmbedding(
  title: string,
  content: string,
  vector: number[],
  tenantId: string = testTenantId,
  isActive: boolean = true,
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO kb_entries (tenant_id, title, content, content_type, source, embedding, is_active)
    VALUES (
      ${tenantId}::uuid, ${title}, ${content}, 'markdown', 'manual',
      ${vectorLiteral(vector)}::vector, ${isActive}
    )
    RETURNING id
  `);
  return result.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests: similarity search fundamentals
// ---------------------------------------------------------------------------

describe("buildKbContextSection - similarity search", () => {
  it("returns relevant entries ahead of irrelevant ones (controlled vectors)", async () => {
    if (!dbAvailable) return;

    // Relevant entry: vector points in dims [0,1,2]
    // Irrelevant entry: vector points in dims [100,101,102]
    // Query vector: matches relevant dims - cosine similarity 1.0 vs 0.0
    const relevantVec = makeVector([0, 1, 2]);
    const irrelevantVec = makeVector([100, 101, 102]);

    await insertEntryWithEmbedding("Relevant Entry", "This is highly relevant content.", relevantVec);
    await insertEntryWithEmbedding("Irrelevant Entry", "This is about something else.", irrelevantVec);

    // Query vector matches the relevant entry
    const queryVec = relevantVec;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: queryVec }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "feature comparison");

    expect(result).toBeDefined();
    expect(result).toContain("Relevant Entry");
    expect(result).not.toContain("Irrelevant Entry");
  });

  it("similarity floor excludes weak matches", async () => {
    if (!dbAvailable) return;

    // Weak vector: half the shared dims - cosine similarity ~0.5 (below 0.70 floor)
    const strongVec = makeVector([0, 1, 2]);
    const weakVec = makeVector([0, 1, 2, 10, 11, 12, 13, 14]); // shares only 3/8 dimensions

    await insertEntryWithEmbedding("Strong Match", "Strongly relevant content.", strongVec);
    await insertEntryWithEmbedding("Weak Match", "Weakly related content.", weakVec);

    // Query vector matches strong dims exactly
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: makeVector([0, 1, 2]) }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "feature info");

    expect(result).toBeDefined();
    expect(result).toContain("Strong Match");
    // Weak match has cosine similarity below floor - must be excluded
    expect(result).not.toContain("Weak Match");
  });

  it("returns at most KB_MAX_RESULTS entries", async () => {
    if (!dbAvailable) return;

    // Insert KB_MAX_RESULTS + 2 perfectly matching entries
    const vec = makeVector([0, 1, 2]);
    for (let i = 1; i <= KB_MAX_RESULTS + 2; i++) {
      await insertEntryWithEmbedding(`Entry ${i}`, `Content ${i}`, vec);
    }

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "query");
    expect(result).toBeDefined();

    // Count how many entry blocks are in the result (each starts with "[Entry N]")
    const matches = result!.match(/^\[/gm);
    expect(matches!.length).toBeLessThanOrEqual(KB_MAX_RESULTS);
  });

  it("entries from another tenant never appear", async () => {
    if (!dbAvailable) return;

    const vec = makeVector([0, 1, 2]);
    // Insert for other tenant
    await insertEntryWithEmbedding("Other Tenant Entry", "Cross-tenant content.", vec, otherTenantId);
    // Insert for test tenant
    await insertEntryWithEmbedding("Own Entry", "Own content.", vec, testTenantId);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "query");
    expect(result).toBeDefined();
    expect(result).not.toContain("Other Tenant Entry");
    expect(result).toContain("Own Entry");
  });
});

// ---------------------------------------------------------------------------
// Tests: kb_ref (explicit author intent)
// ---------------------------------------------------------------------------

describe("buildKbContextSection - explicit kb_ref", () => {
  it("kb_ref entry is always included even if its similarity would fall below floor", async () => {
    if (!dbAvailable) return;

    const queryVec = makeVector([0, 1, 2]);
    // kb_ref entry points in completely different directions - similarity ~0
    const pinnedVec = makeVector([500, 501, 502]);
    // High-similarity entry for comparison
    const highSimVec = makeVector([0, 1, 2]);

    const pinnedId = await insertEntryWithEmbedding("Pinned Entry", "Pinned content.", pinnedVec);
    await insertEntryWithEmbedding("High Sim Entry", "Very relevant content.", highSimVec);

    void pinnedId;

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: queryVec }] }),
    });

    const result = await buildKbContextSection(
      db,
      testTenantId,
      "feature query",
      "Pinned Entry", // kb_ref
    );

    expect(result).toBeDefined();
    // Pinned entry must appear even though its similarity to queryVec is ~0
    expect(result).toContain("Pinned Entry");
    // High-sim entry fills the remaining slot(s)
    expect(result).toContain("High Sim Entry");
  });

  it("kb_ref entry absent: similarity fills all slots", async () => {
    if (!dbAvailable) return;

    const vec = makeVector([0, 1, 2]);
    await insertEntryWithEmbedding("Sim Entry A", "Content A.", vec);
    await insertEntryWithEmbedding("Sim Entry B", "Content B.", vec);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    });

    // kb_ref = "Nonexistent Entry" - not found; similarity fills all KB_MAX_RESULTS slots
    const result = await buildKbContextSection(
      db,
      testTenantId,
      "query",
      "Nonexistent Entry",
    );

    // Both similarity entries should appear (no pinned slot consumed)
    expect(result).toBeDefined();
    expect(result).toContain("Sim Entry A");
    expect(result).toContain("Sim Entry B");
  });
});

// ---------------------------------------------------------------------------
// Tests: graceful degradation
// ---------------------------------------------------------------------------

describe("buildKbContextSection - graceful degradation", () => {
  it("tenant with no embedded entries returns undefined (no section emitted)", async () => {
    if (!dbAvailable) return;
    // No KB entries for this tenant - expect undefined not an error
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: makeVector([0, 1, 2]) }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "any query");
    expect(result).toBeUndefined();
  });

  it("inactive entries are excluded from results", async () => {
    if (!dbAvailable) return;
    const vec = makeVector([0, 1, 2]);
    await insertEntryWithEmbedding("Active Entry", "Active content.", vec, testTenantId, true);
    await insertEntryWithEmbedding("Inactive Entry", "Inactive content.", vec, testTenantId, false);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "query");
    expect(result).toBeDefined();
    expect(result).toContain("Active Entry");
    expect(result).not.toContain("Inactive Entry");
  });

  it("entries without embeddings are excluded from results", async () => {
    if (!dbAvailable) return;
    // Insert an entry without an embedding via raw SQL
    await db.execute(sql`
      INSERT INTO kb_entries (tenant_id, title, content, content_type, source, is_active)
      VALUES (${testTenantId}::uuid, 'No Embedding Entry', 'Content without embedding.', 'markdown', 'manual', true)
    `);
    // Insert one with an embedding
    const vec = makeVector([0, 1, 2]);
    await insertEntryWithEmbedding("With Embedding Entry", "Content with embedding.", vec);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    });

    const result = await buildKbContextSection(db, testTenantId, "query");
    expect(result).toBeDefined();
    expect(result).toContain("With Embedding Entry");
    expect(result).not.toContain("No Embedding Entry");
  });

  it("no provider and no word match returns undefined without throwing", async () => {
    if (!dbAvailable) return;
    // Use otherTenantId which has no llm_configs row
    const vec = makeVector([0, 1, 2]);
    await insertEntryWithEmbedding("Other Tenant KB", "Content.", vec, otherTenantId);

    const result = await buildKbContextSection(db, otherTenantId, "query");
    expect(result).toBeUndefined();
    // fetch must not have been called (no provider: no embedding call)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: keyword fallback (no embedding provider, or a failed query embedding)
// ---------------------------------------------------------------------------

async function insertPlainEntry(title: string, content: string, tenantId: string, isActive = true): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO kb_entries (tenant_id, title, content, content_type, source, is_active, embedding_status)
    VALUES (${tenantId}::uuid, ${title}, ${content}, 'markdown', 'manual', ${isActive}, 'skipped')
    RETURNING id
  `);
  return result.rows[0]!.id;
}

describe("buildKbContextSection - keyword fallback", () => {
  it("no provider: unembedded entries are found by shared words, most shared first", async () => {
    if (!dbAvailable) return;
    await insertPlainEntry("Webhooks and the API", "A webhook posts each new record to your URL.", otherTenantId);
    await insertPlainEntry("Plans and quota", "Pricing plans: Free, Pro and Business. The monthly quota counts companies.", otherTenantId);
    await insertPlainEntry("Hiring signals", "Career pages show which team is hiring.", otherTenantId);
    await insertPlainEntry("Quota (inactive)", "Pricing plans quota monthly.", otherTenantId, false);

    const result = await buildKbContextSection(
      db,
      otherTenantId,
      "Explain the pricing plans and the monthly quota: nurture_value",
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result).toContain("[Plans and quota]");
    expect(result).not.toContain("Webhooks and the API");
    expect(result).not.toContain("Hiring signals");
    expect(result).not.toContain("inactive");
  });

  it("stop words alone do not make a match", async () => {
    if (!dbAvailable) return;
    await insertPlainEntry("Generic", "This is about the thing that they have for you.", otherTenantId);
    const result = await buildKbContextSection(db, otherTenantId, "what about the thing for you: nurture_value");
    // "thing" is the only shared non-stop word: below the 2-word minimum.
    expect(result).toBeUndefined();
  });

  it("kb_ref finds an entry without an embedding", async () => {
    if (!dbAvailable) return;
    await insertPlainEntry("Founding price", "Lock the founding price before it ends.", otherTenantId);
    const result = await buildKbContextSection(db, otherTenantId, "unrelated words", "Founding price");
    expect(result).toContain("[Founding price]");
  });

  it("provider configured but the query embedding fails: falls back to words", async () => {
    if (!dbAvailable) return;
    await insertPlainEntry("Plans and quota", "Pricing plans and the monthly quota.", testTenantId);
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" });

    const result = await buildKbContextSection(db, testTenantId, "pricing plans quota: nurture_value");
    expect(mockFetch).toHaveBeenCalled();
    expect(result).toContain("[Plans and quota]");
  });
});

// ---------------------------------------------------------------------------
// Tests: truncation - kb_context is first dropped
// ---------------------------------------------------------------------------

describe("buildKbContextSection - truncation order", () => {
  it("kb_context is the first section dropped when budget is exceeded", async () => {
    if (!dbAvailable) return;

    // Build a context with a populated kb_context field
    const longKbContent = "A".repeat(500); // enough to contribute tokens
    const ctx: DraftPromptContext = {
      action_type: "nurture_value",
      brain_instruction: "Highlight the feature the user has not tried.",
      kb_context: longKbContent,
      contact: { name: "Jane Doe", email: "jane@example.com" },
      lifecycle: { state: "at_risk", tenure_days: 45 },
      cadence: { current_7d: 2, previous_7d: 5, trend: "declining" },
      behavior: {
        recent_events: ["event_1 at 2026-07-01", "event_2 at 2026-07-02"],
        most_used_features: ["feature_a", "feature_b"],
      },
      prior_contact: { total_messages_sent: 3, messages_opened: 2 },
    };

    // Use a tiny budget that forces truncation
    const result = applyBudgetTruncation(ctx, 10);

    // kb_context must be the first section dropped
    expect(result.droppedSections[0]).toBe("kb_context");
    expect(result.ctx.kb_context).toBeUndefined();
  });

  it("when budget is sufficient, kb_context is preserved", async () => {
    if (!dbAvailable) return;

    const ctx: DraftPromptContext = {
      action_type: "nurture_value",
      kb_context: "Short KB context.",
      contact: { name: "Jane" },
      lifecycle: { state: "engaged" },
    };

    // Large budget - nothing should be dropped
    const result = applyBudgetTruncation(ctx, 100_000);
    expect(result.droppedSections).toHaveLength(0);
    expect(result.ctx.kb_context).toBe("Short KB context.");
  });
});
