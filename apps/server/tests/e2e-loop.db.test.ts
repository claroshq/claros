/**
 * End-to-end integration test: ingested event -> delivered email.
 *
 * Exercises the full chain through real code and a real database:
 *   1. Ingest (POST /v1/track) creates contact + event + membership.
 *   2. Trigger-check handler enrolls the contact in a flow.
 *   3. Step advancement creates a lifecycle_message (pending_generation).
 *   4. Content tick calls the LLM (stubbed at fetch boundary) -> pending_approval.
 *   5. Approve via API -> approved.
 *   6. Drain tick sends via transport (stubbed at fetch boundary) -> sent.
 *
 * Stubs: global fetch is intercepted. LLM calls to /v1/chat/completions return
 * canned decide/draft/assess JSON. Transport calls to api.resend.com return a
 * mock provider message ID. Everything else (DB, ingest, enrollment, step
 * advancement, content pipeline, approval, drain) runs the real production code.
 *
 * What this does NOT cover:
 * - pg-boss scheduling (tick functions are called directly; the cron join is
 *   not tested here - that's pg-boss's responsibility).
 * - Real LLM output quality or hallucination.
 * - Real SMTP/Resend delivery (network stubbed at fetch boundary).
 * - Multi-tenant drain fairness / throttle gate / send window / timezone logic.
 * - Value gate rejection path (assess always passes here).
 * - Re-entry policy enforcement (flow is reentry: once; not exercised twice).
 *
 * Requires local Postgres with migration 0018+ applied.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { buildApp } from "@claros/api";
import {
  handleTriggerCheck,
  phaseStepAdvancement,
  processContentTick,
  processDrainTick,
  fetchDrainBatchSimple,
  buildTenantTransportResolver,
} from "@claros/worker";
import {
  tenants,
  users,
  sessions,
  apiKeys,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[e2e.test] DATABASE_URL is not set.");
}

const SLUG = "test-e2e-loop";
// Self-contained test encryption key (not the real one; only this test's rows use it)
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const POSTAL_ADDRESS = "E2E Test, 1 Loop St, 12345 Berlin, DE";

// ---------------------------------------------------------------------------
// LLM stub responses (canned JSON matching brain-oss output schemas)
// ---------------------------------------------------------------------------

const DECIDE_RESPONSE = JSON.stringify({
  action: "contact",
  reasoning: "E2E test: always contact.",
});
const DRAFT_RESPONSE = JSON.stringify({
  subject: "E2E: Hello from the loop test",
  body_markdown: "This email proves the **full chain** works.",
});
const ASSESS_RESPONSE = JSON.stringify({
  verdict: "pass",
  reasoning: "E2E test: always pass.",
});

let llmCallCount = 0;
const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  // LLM chat completions (decide, draft, assess in sequence)
  if (urlStr.includes("/chat/completions")) {
    llmCallCount++;
    const responses = [DECIDE_RESPONSE, DRAFT_RESPONSE, ASSESS_RESPONSE];
    const responseBody = responses[llmCallCount - 1] ?? ASSESS_RESPONSE;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: responseBody } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // Embedding calls (KB context - soft dependency, return dummy vector)
  if (urlStr.includes("/embeddings")) {
    return new Response(
      JSON.stringify({ data: [{ embedding: new Array(1536).fill(0) }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // Transport calls (Resend)
  if (urlStr.includes("resend.com")) {
    return new Response(
      JSON.stringify({ id: "mock-provider-msg-id" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // Any other URL: return a generic error (don't throw; soft degradation paths expect it)
  return new Response("Not Found", { status: 404 });
});

// ---------------------------------------------------------------------------
// DB state
// ---------------------------------------------------------------------------

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantId: string;
let sessionId: string;
let rawApiKey: string;
let flowId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[e2e.test] DB unreachable: ${(err as Error).message}`);
    }
    console.warn("[e2e.test] DB unreachable - test skipped.");
    return;
  }

  // Cleanup
  for (const tbl of [
    "tenant_daily_usage", "lifecycle_messages", "flow_memberships", "lifecycle_transitions",
    "events", "contacts", "api_keys", "flows", "sessions", "users",
  ]) {
    await db.execute(sql.raw(
      `DELETE FROM ${tbl} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = '${SLUG}')`,
    ));
  }
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);

  // Tenant with postal address + LLM config + transport config
  const [t] = await db.insert(tenants).values({
    name: "E2E Loop Tenant",
    slug: SLUG,
    plan: "free",
    settings: { postal_address: POSTAL_ADDRESS },
  }).returning({ id: tenants.id });
  tenantId = t!.id;

  // User + session
  const [u] = await db.insert(users).values({
    tenantId,
    email: "e2e@loop.test",
    role: "owner",
  }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({
    tenantId,
    userId: u!.id,
    expiresAt: new Date(Date.now() + 86400000),
  }).returning({ id: sessions.id });
  sessionId = s!.id;

  // API key (secret)
  rawApiKey = `cl_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
  await db.insert(apiKeys).values({
    tenantId,
    keyHash,
    prefix: rawApiKey.slice(0, 8),
    kind: "secret",
  });

  // LLM config (encrypted envelope pointing at a fake base_url)
  // Set ENCRYPTION_KEY for this test process (provider-resolver reads it at runtime)
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;
  process.env.UNSUBSCRIBE_SIGNING_KEY = "test-e2e-signing-key-32-bytes!!";
  const encKey = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  const llmCreds = JSON.stringify({
    apiKey: "sk-fake-e2e",
    baseUrl: "http://fake-llm.test",
    model: "gpt-4o",
  });
  await db.execute(sql`
    INSERT INTO llm_configs(tenant_id, provider, config, is_active)
    VALUES (${tenantId}, 'openai', ${encrypt(llmCreds, encKey)}, true)
  `);

  // Transport config (encrypted Resend credentials)
  const transportCreds = JSON.stringify({ apiKey: "re_fake_e2e" });
  const transportEnvelope = encrypt(transportCreds, encKey);
  await db.execute(sql`
    INSERT INTO transport_configs(tenant_id, provider, config, is_active, from_email, from_name)
    VALUES (${tenantId}, 'resend', ${transportEnvelope}, true, 'e2e@test.claros.org', 'E2E Test')
  `);

  // Flow: event trigger, compiled, approval required
  const [f] = await db.insert(flows).values({
    tenantId,
    name: "E2E Loop Flow",
    priority: 10,
    triggerType: "event",
    triggerConfig: { event: "e2e_trigger" },
    steps: [],
    source: "manual",
    status: "active",
    approvalMode: "require",
    flowClass: "nurture",
    reentryPolicy: "once",
    reentryCooldownDays: 30,
    compileStatus: "ready",
    compiledPlan: {
      trigger: { type: "event", condition: { event: "e2e_trigger" } },
      steps: [{
        order: 1,
        action_type: "nurture_value",
        delay: "0m",
        window_policy: "immediate",
        brain_instruction: "Welcome the user.",
      }],
    },
    compiledAt: new Date(),
  }).returning({ id: flows.id });
  flowId = f!.id;

  // Stub global fetch
  vi.stubGlobal("fetch", mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  // Cleanup
  for (const tbl of [
    "tenant_daily_usage", "lifecycle_messages", "flow_memberships", "lifecycle_transitions",
    "events", "contacts", "api_keys", "flows", "llm_configs", "transport_configs",
    "sessions", "users",
  ]) {
    await db.execute(sql.raw(
      `DELETE FROM ${tbl} WHERE tenant_id = '${tenantId}'`,
    ));
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("database availability sentinel", () => {
  it("database unavailable: e2e test skipped", () => {
    if (dbAvailable) return;
    expect(true).toBe(true);
  });
});

describe("end-to-end: event -> email", () => {
  it("ingested event reaches sent status through every join", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // === 1. Ingest: identify + track ===
    const identifyRes = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "e2e_user_1", traits: { email: "e2e@test.claros.org", name: "E2E User" } },
    });
    expect(identifyRes.statusCode).toBe(200);

    const trackRes = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "e2e_user_1", event: "e2e_trigger" },
    });
    expect(trackRes.statusCode).toBe(200);

    // Verify contact was created
    const contact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, "e2e_user_1"))
      .limit(1);
    expect(contact.length).toBe(1);
    const contactId = contact[0]!.id;

    // === 2. Trigger-check: enrollment ===
    await handleTriggerCheck(
      { tenant_id: tenantId, contact_id: contactId, event_name: "e2e_trigger" },
      db,
    );

    const membership = await db
      .select({ id: flowMemberships.id, status: flowMemberships.status })
      .from(flowMemberships)
      .where(eq(flowMemberships.contactId, contactId))
      .limit(1);
    expect(membership.length).toBe(1);
    expect(membership[0]!.status).toBe("active");
    const membershipId = membership[0]!.id;

    // === 3. Step advancement: create message ===
    const advResult = await phaseStepAdvancement(db, new Date(), [tenantId]);
    expect(advResult.messagesCreated).toBeGreaterThanOrEqual(1);

    const msg = await db
      .select({ id: lifecycleMessages.id, status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.membershipId, membershipId))
      .limit(1);
    expect(msg.length).toBe(1);
    expect(msg[0]!.status).toBe("pending_generation");
    const messageId = msg[0]!.id;

    // === 4. Content generation (LLM stubbed) ===
    llmCallCount = 0;
    const contentResult = await processContentTick(db, new Date(), 20, [tenantId]);
    expect(contentResult.advanced).toBe(1);
    expect(llmCallCount).toBe(3); // decide + draft + assess

    const afterContent = await db
      .select({ status: lifecycleMessages.status, subject: lifecycleMessages.subject })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId))
      .limit(1);
    expect(afterContent[0]!.status).toBe("pending_approval");
    expect(afterContent[0]!.subject).toBe("E2E: Hello from the loop test");

    // === 5. Approve via API ===
    const approveRes = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: `claros_session=${sessionId}` },
    });
    expect(approveRes.statusCode).toBe(200);

    // === 6. Drain (transport stubbed, tenant-scoped to avoid cross-contamination) ===
    const resolver = buildTenantTransportResolver(db);
    const scopedFetchBatch = (dbArg: any, now: Date, limit: number, _tenantIds: string[]) =>
      fetchDrainBatchSimple(dbArg, now, limit, [tenantId]);
    const drainResult = await processDrainTick(
      db, new Date(), resolver, scopedFetchBatch, 50,
      "http://localhost:3000", process.env.UNSUBSCRIBE_SIGNING_KEY,
    );
    expect(drainResult.sent).toBeGreaterThanOrEqual(1);

    // Final state: sent with provider_message_id from the stub
    const final = await db
      .select({
        status: lifecycleMessages.status,
        providerMessageId: lifecycleMessages.providerMessageId,
        recipientAddress: lifecycleMessages.recipientAddress,
      })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId))
      .limit(1);
    expect(final[0]!.status).toBe("sent");
    expect(final[0]!.providerMessageId).toBe("mock-provider-msg-id");

    await app.close();
  }, 30000);
});
