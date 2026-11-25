/**
 * End-to-end test for person-written (fixed_content) flows.
 *
 * Proves the full path without an LLM:
 *   1. Create a fixed_content flow through the API (POST /v1/flows + POST /v1/flows/:id/plan).
 *   2. Activate it (no LLM check required; plan is already ready).
 *   3. Fire an event trigger to enroll two contacts:
 *      - Contact A has first_name set -> variable substitution runs.
 *      - Contact B has no first_name  -> pipe fallback runs.
 *   4. Run step advancement -> messages enter pending_generation.
 *   5. Run content tick -> processTemplateMessage renders each message.
 *      Asserts fetch was never called (no LLM call whatsoever).
 *   6. Messages reach approved directly (approval_mode = auto).
 *      Verify rendered subject and body for both contacts.
 *
 * Then verifies the AI draft endpoint (POST /v1/flows/:id/draft-step):
 *   - With no LLM configured: 422.
 *   - With LLM configured and existing content in editor: returns new draft
 *     but does NOT auto-apply it (the endpoint returns a value, not a DB write).
 *
 * Requires local Postgres (docker compose up postgres).
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
  templates,
} from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[fixed-content-e2e.test] DATABASE_URL is not set.");
}

const SLUG = "test-fixed-content-e2e";
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const POSTAL_ADDRESS = "Fixed Content E2E, 1 Test St, 12345 Berlin, DE";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantId: string;
let sessionId: string;
let rawApiKey: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[fixed-content-e2e.test] DB unreachable - test skipped.");
    return;
  }

  // Clean up from any prior run
  for (const tbl of [
    "tenant_daily_usage", "lifecycle_messages", "flow_memberships", "lifecycle_transitions",
    "events", "contacts", "api_keys", "flows", "templates", "sessions", "users",
  ]) {
    await db.execute(sql.raw(
      `DELETE FROM ${tbl} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = '${SLUG}')`,
    ));
  }
  await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);

  // Tenant with postal address, NO LLM config initially
  const [t] = await db.insert(tenants).values({
    name: "Fixed Content E2E Tenant",
    slug: SLUG,
    plan: "free",
    settings: { postal_address: POSTAL_ADDRESS },
  }).returning({ id: tenants.id });
  tenantId = t!.id;

  // User + session
  const [u] = await db.insert(users).values({
    tenantId,
    email: "e2e@fixed-content.test",
    role: "owner",
  }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({
    tenantId,
    userId: u!.id,
    expiresAt: new Date(Date.now() + 86400000),
  }).returning({ id: sessions.id });
  sessionId = s!.id;

  // API key
  rawApiKey = `cl_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
  await db.insert(apiKeys).values({
    tenantId,
    keyHash,
    prefix: rawApiKey.slice(0, 8),
    kind: "secret",
  });

  // Set ENCRYPTION_KEY (needed by resolveTenantProvider if LLM is ever added)
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;
  process.env.UNSUBSCRIBE_SIGNING_KEY = "fixed-e2e-signing-key-32bytes!!!";
});

afterAll(async () => {
  if (dbAvailable) {
    for (const tbl of [
      "tenant_daily_usage", "lifecycle_messages", "flow_memberships", "lifecycle_transitions",
      "events", "contacts", "api_keys", "flows", "templates", "sessions", "users",
    ]) {
      await db.execute(sql.raw(
        `DELETE FROM ${tbl} WHERE tenant_id = '${tenantId}'`,
      ));
    }
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("database availability sentinel", () => {
  it("database unavailable: fixed-content e2e test skipped", () => {
    if (dbAvailable) return;
    expect(true).toBe(true);
  });
});

describe("end-to-end: fixed_content flow - no LLM required", () => {
  it("person-written flow: create, save plan, activate, fire trigger, render variables", async () => {
    if (!dbAvailable) return;

    // Capture every fetch call to prove no LLM call happens
    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      fetchCalls.push(urlStr);
      // Return an error for anything that reaches here - if the template path
      // is correct, this code is never reached.
      return new Response("fetch should not have been called", { status: 500 });
    });

    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
    });

    const cookie = `claros_session=${sessionId}`;

    // === STEP 1: Create the fixed_content flow ===
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { cookie },
      payload: {
        name: "Fixed E2E Flow",
        trigger_type: "event",
        trigger_config: { event: "fixed_e2e_trigger" },
        steps: [],
        content_mode: "fixed_content",
        approval_mode: "auto",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdFlow = createRes.json() as { id: string; content_mode: string; compile_status: string | null; approval_mode: string };
    expect(createdFlow.content_mode).toBe("fixed_content");
    expect(createdFlow.compile_status).toBeNull();
    expect(createdFlow.approval_mode).toBe("auto");
    const flowId = createdFlow.id;

    // === STEP 2: Save a plan with two steps ===
    // Step 1: welcome email immediately, uses {{contact.first_name|there}} (pipe fallback)
    // Step 2: follow-up after 3 days, uses {{contact.company|your team}} (pipe fallback)
    const planRes = await app.inject({
      method: "POST",
      url: `/v1/flows/${flowId}/plan`,
      headers: { cookie },
      payload: {
        steps: [
          {
            order: 1,
            delay: "0m",
            action_type: "onboard_welcome",
            window_policy: "immediate",
            subject: "Welcome {{contact.first_name|there}}!",
            body_html: "<p>Hi {{contact.first_name|there}}, welcome to {{tenant.name}}.</p><p>We are glad you are here.</p>",
            body_text: "Hi {{contact.first_name|there}}, welcome to {{tenant.name}}. We are glad you are here.",
          },
          {
            order: 2,
            delay: "3d",
            action_type: "nurture_value",
            window_policy: "respect_window",
            subject: "How is {{contact.company|your team}} getting on?",
            body_html: "<p>Hi {{contact.first_name|there}}, how is {{contact.company|your team}} finding {{tenant.name}} so far?</p>",
          },
        ],
      },
    });
    expect(planRes.statusCode).toBe(200);
    const updatedFlow = planRes.json() as { compile_status: string; compiled_plan: Record<string, unknown> };
    expect(updatedFlow.compile_status).toBe("ready");
    const plan = updatedFlow.compiled_plan;
    expect((plan.steps as unknown[]).length).toBe(2);
    // Each step must carry a template_ref pointing at the created templates
    const step1 = (plan.steps as Array<Record<string, string>>)[0]!;
    const step2 = (plan.steps as Array<Record<string, string>>)[1]!;
    expect(step1.template_ref).toBe(`flow-${flowId}-step-1`);
    expect(step2.template_ref).toBe(`flow-${flowId}-step-2`);

    // Verify templates were actually created in the database
    const tmplRows = await db
      .select({ slug: templates.slug, subject: templates.subject })
      .from(templates)
      .where(eq(templates.tenantId, tenantId));
    const slugs = tmplRows.map((r) => r.slug);
    expect(slugs).toContain(`flow-${flowId}-step-1`);
    expect(slugs).toContain(`flow-${flowId}-step-2`);

    // === STEP 3: Activate (no LLM check - plan is already ready) ===
    const activateRes = await app.inject({
      method: "PATCH",
      url: `/v1/flows/${flowId}`,
      headers: { cookie },
      payload: { status: "active" },
    });
    expect(activateRes.statusCode).toBe(200);
    expect(activateRes.json().status).toBe("active");

    // === STEP 4: Ingest events for two contacts ===
    // Contact A: has first_name and company - variables render fully
    const identifyARes = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: {
        userId: "fixed_e2e_user_a",
        traits: { email: "alice@example.com", first_name: "Alice", company: "Acme Corp" },
      },
    });
    expect(identifyARes.statusCode).toBe(200);

    const trackARes = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "fixed_e2e_user_a", event: "fixed_e2e_trigger" },
    });
    expect(trackARes.statusCode).toBe(200);

    // Contact B: no first_name, no company - pipe fallbacks kick in
    const identifyBRes = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: {
        userId: "fixed_e2e_user_b",
        traits: { email: "bob@example.com" },
      },
    });
    expect(identifyBRes.statusCode).toBe(200);

    const trackBRes = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "fixed_e2e_user_b", event: "fixed_e2e_trigger" },
    });
    expect(trackBRes.statusCode).toBe(200);

    // === STEP 5: Enrollment ===
    const contactA = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, "fixed_e2e_user_a"))
      .limit(1);
    expect(contactA.length).toBe(1);
    const contactAId = contactA[0]!.id;

    const contactB = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, "fixed_e2e_user_b"))
      .limit(1);
    expect(contactB.length).toBe(1);
    const contactBId = contactB[0]!.id;

    // Enroll both
    await handleTriggerCheck(
      { tenant_id: tenantId, contact_id: contactAId, event_name: "fixed_e2e_trigger" },
      db,
    );
    await handleTriggerCheck(
      { tenant_id: tenantId, contact_id: contactBId, event_name: "fixed_e2e_trigger" },
      db,
    );

    // Verify memberships created
    const memberships = await db
      .select({ id: flowMemberships.id, contactId: flowMemberships.contactId, status: flowMemberships.status })
      .from(flowMemberships)
      .where(eq(flowMemberships.flowId, flowId));
    expect(memberships.length).toBe(2);
    expect(memberships.every((m) => m.status === "active")).toBe(true);

    const membershipAId = memberships.find((m) => m.contactId === contactAId)!.id;
    const membershipBId = memberships.find((m) => m.contactId === contactBId)!.id;

    // === STEP 6: Step advancement ===
    const advResult = await phaseStepAdvancement(db, new Date(), [tenantId]);
    expect(advResult.messagesCreated).toBe(2);

    // Messages must be at pending_generation
    const msgA = await db
      .select({ id: lifecycleMessages.id, status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.membershipId, membershipAId))
      .limit(1);
    expect(msgA.length).toBe(1);
    expect(msgA[0]!.status).toBe("pending_generation");
    const msgAId = msgA[0]!.id;

    const msgB = await db
      .select({ id: lifecycleMessages.id, status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.membershipId, membershipBId))
      .limit(1);
    expect(msgB.length).toBe(1);
    expect(msgB[0]!.status).toBe("pending_generation");
    const msgBId = msgB[0]!.id;

    // === STEP 7: Content tick - template path, no LLM ===
    // Reset fetch tracker before the content tick
    fetchCalls.length = 0;

    const contentResult = await processContentTick(db, new Date(), 20, [tenantId]);
    expect(contentResult.advanced).toBe(2);

    // CRITICAL: no fetch calls should have happened
    // The template path (content.ts:331) returns before resolving any LLM provider
    expect(fetchCalls.length).toBe(0);

    // === STEP 8: Verify rendered content ===
    // Contact A: first_name="Alice", company="Acme Corp" -> variables render
    const finalA = await db
      .select({
        status: lifecycleMessages.status,
        subject: lifecycleMessages.subject,
        bodyHtml: lifecycleMessages.bodyHtml,
        bodyText: lifecycleMessages.bodyText,
        brainReasoning: lifecycleMessages.brainReasoning,
        approvedAt: lifecycleMessages.approvedAt,
      })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, msgAId))
      .limit(1);
    expect(finalA.length).toBe(1);
    const a = finalA[0]!;
    // approval_mode = auto -> goes straight to approved
    expect(a.status).toBe("approved");
    expect(a.approvedAt).not.toBeNull();
    // Subject: "Welcome Alice!" (variable substituted)
    expect(a.subject).toBe("Welcome Alice!");
    // Body: Alice's name rendered
    expect(a.bodyHtml).toContain("Hi Alice, welcome to Fixed Content E2E Tenant.");
    // brain_reasoning records which template was used
    expect(a.brainReasoning).toMatch(/^template_rendered:/);

    // Contact B: no first_name, no company -> pipe fallbacks
    const finalB = await db
      .select({
        status: lifecycleMessages.status,
        subject: lifecycleMessages.subject,
        bodyHtml: lifecycleMessages.bodyHtml,
        bodyText: lifecycleMessages.bodyText,
      })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, msgBId))
      .limit(1);
    expect(finalB.length).toBe(1);
    const b = finalB[0]!;
    expect(b.status).toBe("approved");
    // Subject: fallback "there" used (contact.first_name not set -> pipe gives "there")
    expect(b.subject).toBe("Welcome there!");
    // Body: fallback used
    expect(b.bodyHtml).toContain("Hi there, welcome to Fixed Content E2E Tenant.");

    await app.close();
    vi.unstubAllGlobals();
  }, 30000);

  it("AI draft endpoint returns 422 with no LLM configured", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const cookie = `claros_session=${sessionId}`;

    // Get the flow we created in the previous test
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/flows",
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const flowList = listRes.json().flows as Array<{ id: string; name: string }>;
    const flow = flowList.find((f) => f.name === "Fixed E2E Flow");
    expect(flow).toBeDefined();

    // No LLM configured -> 422
    const draftRes = await app.inject({
      method: "POST",
      url: `/v1/flows/${flow!.id}/draft-step`,
      headers: { cookie },
      payload: { step_order: 1 },
    });
    expect(draftRes.statusCode).toBe(422);
    expect(draftRes.json().error).toContain("No LLM configuration");

    await app.close();
  }, 10000);

  it("AI draft endpoint returns copy without overwriting DB when LLM is configured", async () => {
    if (!dbAvailable) return;

    // Add an LLM config (stubbed at fetch boundary)
    const encKey = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const llmCreds = JSON.stringify({
      apiKey: "sk-fake-fixed-e2e",
      baseUrl: "http://fake-llm-fixed.test",
      model: "gpt-4o",
    });
    await db.execute(sql`
      INSERT INTO llm_configs(tenant_id, provider, config, is_active)
      VALUES (${tenantId}, 'openai', ${encrypt(llmCreds, encKey)}, true)
    `);

    // Stub fetch: LLM returns a specific draft response
    const DRAFT_SUBJECT = "AI Draft: Welcome Alice!";
    const DRAFT_BODY_MARKDOWN = "Hi {{contact.first_name|there}}, this draft was generated by AI.";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({ subject: DRAFT_SUBJECT, body_markdown: DRAFT_BODY_MARKDOWN }),
              },
            }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const cookie = `claros_session=${sessionId}`;

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/flows",
      headers: { cookie },
    });
    const flowList = listRes.json().flows as Array<{ id: string; name: string }>;
    const flow = flowList.find((f) => f.name === "Fixed E2E Flow")!;

    // The editor has existing content ("Welcome Alice!" from the template)
    // The draft-step endpoint is called with that existing content
    const draftRes = await app.inject({
      method: "POST",
      url: `/v1/flows/${flow.id}/draft-step`,
      headers: { cookie },
      payload: {
        step_order: 1,
        subject: "Welcome Alice!",
        body_html: "<p>Hi Alice, welcome to Fixed Content E2E Tenant.</p>",
      },
    });

    expect(draftRes.statusCode).toBe(200);
    const draftResult = draftRes.json() as { subject: string; body_html: string };

    // The endpoint returns the AI's suggestion
    expect(draftResult.subject).toBe(DRAFT_SUBJECT);
    expect(draftResult.body_html).toContain("this draft was generated by AI");

    // CRITICAL: The endpoint returns a value, not a DB write.
    // The template in the DB is UNCHANGED - it still has the original "Welcome Alice!" subject.
    const templateInDb = await db
      .select({ subject: templates.subject, bodyHtml: templates.bodyHtml })
      .from(templates)
      .where(eq(templates.tenantId, tenantId))
      .limit(1);
    // Original template subject is still intact
    const originalTemplate = templateInDb.find((t) => t.subject === "Welcome {{contact.first_name|there}}!");
    expect(originalTemplate).toBeDefined();
    // The AI draft subject is NOT in the DB
    const aiDraftInDb = templateInDb.find((t) => t.subject === DRAFT_SUBJECT);
    expect(aiDraftInDb).toBeUndefined();

    await app.close();
    vi.unstubAllGlobals();
  }, 15000);
});
