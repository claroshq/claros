/**
 * Message approval integration tests.
 *
 * Coverage:
 *   - POST /v1/messages/:id/approve advances pending_approval -> approved (CAS)
 *   - Approving an already-approved message returns 200 (idempotent no-op)
 *   - Approving a message in another status returns 409
 *   - POST /v1/messages/:id/reject advances pending_approval -> rejected (terminal)
 *   - Rejecting an already-rejected message returns 200 (idempotent no-op)
 *   - Rejecting a non-pending_approval message returns 409
 *   - Another tenant's message returns 404 (tenant isolation)
 *   - GET /v1/messages lists pending_approval messages with cursor pagination
 *   - An approved message is drain-eligible (matches the drain's claim query)
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, eq } from "drizzle-orm";
import { FONT_STACK } from "@claros/core";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[messages.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

const TEST_BASE_URL = "http://localhost:3000";
const TEST_POSTAL_ADDRESS = "123 Test St, Test City, TC 12345";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let tenantBId: string;
let sessionAId: string;
let cookieA: string;
let sessionBId: string;
let cookieB: string;

const SLUG_A = "test-messages-a";
const SLUG_B = "test-messages-b";

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
        `[messages.test] DATABASE_URL not reachable in CI.\nURL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[messages.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Tenant A
  const [tA] = await db
    .insert(tenants)
    .values({
      name: "Test Messages A",
      slug: SLUG_A,
      plan: "free",
      settings: { postal_address: TEST_POSTAL_ADDRESS },
    })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;

  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@messages.test", role: "owner" })
    .returning({ id: users.id });

  const [sA] = await db
    .insert(sessions)
    .values({
      tenantId: tenantAId,
      userId: uA!.id,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning({ id: sessions.id });
  sessionAId = sA!.id;
  cookieA = `claros_session=${sessionAId}`;

  // Tenant B
  const [tB] = await db
    .insert(tenants)
    .values({ name: "Test Messages B", slug: SLUG_B, plan: "free", settings: { postal_address: TEST_POSTAL_ADDRESS } })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;

  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@messages.test", role: "owner" })
    .returning({ id: users.id });

  const [sB] = await db
    .insert(sessions)
    .values({
      tenantId: tenantBId,
      userId: uB!.id,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning({ id: sessions.id });
  sessionBId = sB!.id;
  cookieB = `claros_session=${sessionBId}`;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (${tenantAId}, ${tenantBId}))`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})))`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
  await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(tenantId: string, externalId: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      email: `${externalId}@example.com`,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(tenantId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(tenantId: string, contactId: string, flowId: string): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertPendingApprovalMessage(
  tenantId: string,
  contactId: string,
  flowId: string,
  membershipId: string,
  opts: { stepOrder?: number } = {},
): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: opts.stepOrder ?? 1,
      status: "pending_approval",
      subject: "Draft subject",
      bodyHtml: "<p>Draft body</p>",
      bodyText: "Draft body",
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[messages.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("POST /v1/messages/:id/approve", () => {
  it("advances pending_approval to approved", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "approve-contact-1");
    const flowId = await insertFlow(tenantAId, "approve-flow-1");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("approved");

    // Verify in DB
    const dbRow = await db.execute<{ status: string; approved_at: string | null }>(sql`
      SELECT status, approved_at FROM lifecycle_messages WHERE id = ${messageId}
    `);
    expect(dbRow.rows[0]!.status).toBe("approved");
    expect(dbRow.rows[0]!.approved_at).not.toBeNull();

    await app.close();
  });

  it("approving an already-approved message is a no-op (200)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "approve-idem");
    const flowId = await insertFlow(tenantAId, "approve-idem-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    // Approve first time
    await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });

    // Approve again
    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("approved");
    expect(body.message).toContain("already");

    await app.close();
  });

  it("approving a message in 'sent' status returns 409", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "approve-sent");
    const flowId = await insertFlow(tenantAId, "approve-sent-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    // Force to 'sent'
    await db.execute(sql`UPDATE lifecycle_messages SET status = 'sent' WHERE id = ${messageId}`);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("sent");

    await app.close();
  });

  it("another tenant's message returns 404", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    // Create message in tenant B
    const contactId = await insertContact(tenantBId, "approve-cross-tenant");
    const flowId = await insertFlow(tenantBId, "approve-cross-flow");
    const membershipId = await insertMembership(tenantBId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantBId, contactId, flowId, membershipId);

    // Try to approve as tenant A
    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("non-existent message returns 404", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/00000000-0000-0000-0000-000000000000/approve`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe("POST /v1/messages/:id/reject", () => {
  it("advances pending_approval to rejected (terminal)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "reject-contact-1");
    const flowId = await insertFlow(tenantAId, "reject-flow-1");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reject`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("rejected");

    // Verify in DB
    const dbRow = await db.execute<{ status: string }>(sql`
      SELECT status FROM lifecycle_messages WHERE id = ${messageId}
    `);
    expect(dbRow.rows[0]!.status).toBe("rejected");

    await app.close();
  });

  it("rejecting an already-rejected message is a no-op (200)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "reject-idem");
    const flowId = await insertFlow(tenantAId, "reject-idem-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reject`,
      headers: { cookie: cookieA },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reject`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toContain("already");

    await app.close();
  });

  it("rejecting a non-pending_approval message returns 409", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "reject-approved");
    const flowId = await insertFlow(tenantAId, "reject-approved-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    // Force to approved
    await db.execute(sql`UPDATE lifecycle_messages SET status = 'approved' WHERE id = ${messageId}`);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reject`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("approved");

    await app.close();
  });

  it("another tenant's message returns 404", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantBId, "reject-cross-tenant");
    const flowId = await insertFlow(tenantBId, "reject-cross-flow");
    const membershipId = await insertMembership(tenantBId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantBId, contactId, flowId, membershipId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reject`,
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe("GET /v1/messages (list pending approval)", () => {
  it("lists only pending_approval messages for the tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "list-contact");
    const flowId = await insertFlow(tenantAId, "list-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].status).toBe("pending_approval");
    expect(body.next_cursor).toBeNull();

    await app.close();
  });

  it("returns preview_html: the body in the branded shell with the step's eyebrow", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "preview-contact");
    const flowId = await insertFlow(tenantAId, "preview-flow");
    await db
      .update(flows)
      .set({
        compiledPlan: {
          trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
          steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate", eyebrow: "Welcome", preheader: "Start here" }],
        },
      })
      .where(eq(flows.id, flowId));
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    const res = await app.inject({ method: "GET", url: "/v1/messages", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body).messages[0];
    expect(msg.body_html).toBe("<p>Draft body</p>");
    expect(msg.preview_html).toMatch(/^<!DOCTYPE html>/);
    expect(msg.preview_html).toContain("<p>Draft body</p>");
    expect(msg.preview_html).toContain(`font-family:${FONT_STACK};`);
    expect(msg.preview_html).toContain('class="email-eyebrow"');
    expect(msg.preview_html).toContain(">Welcome</p>");
    expect(msg.preview_html).toContain("Start here");

    await app.close();
  });

  it("supports cursor pagination", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "list-page-contact");
    const flowId = await insertFlow(tenantAId, "list-page-flow");

    // Insert 3 messages with different step orders for the unique index
    for (let i = 1; i <= 3; i++) {
      const mid = await insertMembership(tenantAId, contactId, flowId);
      await insertPendingApprovalMessage(tenantAId, contactId, flowId, mid, { stepOrder: i });
    }

    // Request page of 2
    const res1 = await app.inject({
      method: "GET",
      url: "/v1/messages?limit=2",
      headers: { cookie: cookieA },
    });

    const body1 = JSON.parse(res1.body);
    expect(body1.messages).toHaveLength(2);
    expect(body1.next_cursor).not.toBeNull();

    // Request next page
    const res2 = await app.inject({
      method: "GET",
      url: `/v1/messages?limit=2&after=${body1.next_cursor}`,
      headers: { cookie: cookieA },
    });

    const body2 = JSON.parse(res2.body);
    expect(body2.messages).toHaveLength(1);
    expect(body2.next_cursor).toBeNull();

    await app.close();
  });

  it("does not return messages from another tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    // Create message in tenant B
    const contactId = await insertContact(tenantBId, "list-cross");
    const flowId = await insertFlow(tenantBId, "list-cross-flow");
    const membershipId = await insertMembership(tenantBId, contactId, flowId);
    await insertPendingApprovalMessage(tenantBId, contactId, flowId, membershipId);

    // List as tenant A
    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { cookie: cookieA },
    });

    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(0);

    await app.close();
  });
});

describe("approved message is drain-eligible", () => {
  it("approve makes the message visible to the drain claim query", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "drain-approve-contact");
    const flowId = await insertFlow(tenantAId, "drain-approve-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    // Before approval: message should NOT match drain's claim query
    const beforeDrain = await db.execute<{ id: string }>(sql`
      SELECT lm.id FROM lifecycle_messages lm
      WHERE lm.status = 'approved'
        AND lm.tenant_id = ${tenantAId}
        AND (lm.scheduled_send_at IS NULL OR lm.scheduled_send_at <= now())
        AND lm.id = ${messageId}
    `);
    expect(beforeDrain.rows).toHaveLength(0);

    // Approve via API
    const approveRes = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/approve`,
      headers: { cookie: cookieA },
    });
    expect(approveRes.statusCode).toBe(200);

    // After approval: message MUST match drain's claim query
    // This is the exact WHERE clause from drain.ts fetchDrainBatchSimple
    const afterDrain = await db.execute<{ id: string }>(sql`
      SELECT lm.id FROM lifecycle_messages lm
      WHERE lm.status = 'approved'
        AND lm.tenant_id = ${tenantAId}
        AND (lm.scheduled_send_at IS NULL OR lm.scheduled_send_at <= now())
        AND lm.id = ${messageId}
    `);
    expect(afterDrain.rows).toHaveLength(1);
    expect(afterDrain.rows[0]!.id).toBe(messageId);

    // Verify approved_at is set (drain uses this for ordering)
    const meta = await db.execute<{ approved_at: string | null }>(sql`
      SELECT approved_at FROM lifecycle_messages WHERE id = ${messageId}
    `);
    expect(meta.rows[0]!.approved_at).not.toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/messages/:id/retry
// ---------------------------------------------------------------------------

describe("POST /v1/messages/:id/retry", () => {
  it("re-queues a generation-failed message to pending_generation", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });
    const contactId = await insertContact(tenantAId, "retry-gen-contact");
    const flowId = await insertFlow(tenantAId, "retry-gen-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);

    const [row] = await db.insert(lifecycleMessages).values({
      tenantId: tenantAId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "failed",
      brainReasoning: "generation_failed: No LLM configuration found.",
      retryCount: 3,
    }).returning({ id: lifecycleMessages.id });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${row!.id}/retry`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("pending_generation");

    // retry_count reset so the fresh attempt gets a full budget
    const msg = await db.execute<{ status: string; retry_count: number }>(sql`
      SELECT status, retry_count FROM lifecycle_messages WHERE id = ${row!.id}
    `);
    expect(msg.rows[0]!.status).toBe("pending_generation");
    expect(msg.rows[0]!.retry_count).toBe(0);

    await app.close();
  });

  it("returns 409 for a send-failed message (no generation_failed marker)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });
    const contactId = await insertContact(tenantAId, "retry-send-fail");
    const flowId = await insertFlow(tenantAId, "retry-send-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);

    const [row] = await db.insert(lifecycleMessages).values({
      tenantId: tenantAId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "failed",
      brainReasoning: null,
    }).returning({ id: lifecycleMessages.id });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${row!.id}/retry`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("returns 404 for another tenant's message", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });
    const contactId = await insertContact(tenantAId, "retry-isolation");
    const flowId = await insertFlow(tenantAId, "retry-isolation-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);

    const [row] = await db.insert(lifecycleMessages).values({
      tenantId: tenantAId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "failed",
      brainReasoning: "generation_failed: test",
    }).returning({ id: lifecycleMessages.id });

    // tenant B tries to retry tenant A's message
    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${row!.id}/retry`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /v1/messages contact join", () => {
  it("includes contact email, name, and external_id in the list payload", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "list-contact-join");
    const flowId = await insertFlow(tenantAId, "list-join-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const messageId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const msg = body.messages.find((m: { id: string }) => m.id === messageId);
    expect(msg).toBeDefined();
    expect(msg.contact).toEqual({
      email: "list-contact-join@example.com",
      name: null,
      external_id: "list-contact-join",
    });

    await app.close();
  });
});

describe("POST /v1/messages/bulk/approve", () => {
  it("approves all pending_approval messages and skips others", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "bulk-approve-contact");
    const flowId = await insertFlow(tenantAId, "bulk-approve-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const id1 = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId, { stepOrder: 1 });
    const id2 = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId, { stepOrder: 2 });

    // A message already approved: must be reported as skipped
    const id3 = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId, { stepOrder: 3 });
    await app.inject({
      method: "POST",
      url: `/v1/messages/${id3}/approve`,
      headers: { cookie: cookieA },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/bulk/approve",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { ids: [id1, id2, id3] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.approved.sort()).toEqual([id1, id2].sort());
    expect(body.skipped).toEqual([id3]);

    const rows = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages WHERE id IN (${id1}, ${id2})
    `);
    for (const row of rows.rows) {
      expect(row.status).toBe("approved");
    }

    await app.close();
  });

  it("never touches another tenant's messages", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "bulk-iso-contact");
    const flowId = await insertFlow(tenantAId, "bulk-iso-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const foreignId = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId);

    // tenant B tries to bulk-approve tenant A's message
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/bulk/approve",
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { ids: [foreignId] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.approved).toEqual([]);
    expect(body.skipped).toEqual([foreignId]);

    const row = await db.execute<{ status: string }>(sql`
      SELECT status FROM lifecycle_messages WHERE id = ${foreignId}
    `);
    expect(row.rows[0]!.status).toBe("pending_approval");

    await app.close();
  });

  it("rejects an invalid body with 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/bulk/approve",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { ids: ["not-a-uuid"] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /v1/messages/bulk/reject", () => {
  it("rejects all pending_approval messages and skips others", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: TEST_BASE_URL });

    const contactId = await insertContact(tenantAId, "bulk-reject-contact");
    const flowId = await insertFlow(tenantAId, "bulk-reject-flow");
    const membershipId = await insertMembership(tenantAId, contactId, flowId);
    const id1 = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId, { stepOrder: 1 });
    const id2 = await insertPendingApprovalMessage(tenantAId, contactId, flowId, membershipId, { stepOrder: 2 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/bulk/reject",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { ids: [id1, id2] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rejected.sort()).toEqual([id1, id2].sort());
    expect(body.skipped).toEqual([]);

    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM lifecycle_messages WHERE id IN (${id1}, ${id2})
    `);
    for (const row of rows.rows) {
      expect(row.status).toBe("rejected");
    }

    await app.close();
  });
});
