/**
 * Behavioural proof for exposed throttle controls (Proofs 1-3).
 * Proof 4 (API validation) is in packages/api/tests/throttle-proof.db.test.ts.
 *
 * Run: npx vitest run tests/throttle-proof.db.test.ts   (via npm test which loads .env)
 * Requires: DATABASE_URL + Postgres running.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  transportConfigs,
} from "@claros/db/schema";
import { makeDrainRunner } from "./drain-test-utils.js";
import type { TransportAdapter, TransportSendResult, TransportSendParams } from "../src/transport.js";

class LogAdapter implements TransportAdapter {
  public sends: string[] = [];
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(p.to);
    return { success: true, providerMessageId: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    `[throttle-proof] DATABASE_URL not set. Export it or run via: npm test\n`,
  );
}

const SLUG = "test-throttle-proof";
const TEST_POSTAL = "1 Proof St, Proof City, PC 00001";
const TEST_SIGNING_KEY = "throttle-proof-signing-key-not-for-production";
const TEST_BASE_URL = "http://localhost:3000";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let transportId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    console.warn(`[throttle-proof] DB unreachable - skipping. ${(err as Error).message}`);
    return;
  }
  await cleanup();

  const [t] = await db.insert(tenants).values({
    name: "Throttle Proof",
    slug: SLUG,
    plan: "free",
    settings: { postal_address: TEST_POSTAL },
  }).returning({ id: tenants.id });
  tenantId = t!.id;

  const [tc] = await db.insert(transportConfigs).values({
    tenantId,
    provider: "resend",
    config: JSON.stringify({ apiKey: "test-key-proof" }),
    isActive: true,
    fromEmail: "proof@example.com",
    dailyLimit: null,
  }).returning({ id: transportConfigs.id });
  transportId = tc!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships   WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM flows              WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts           WHERE tenant_id = ${tenantId}`);
  await db.update(transportConfigs)
    .set({ dailyLimit: null, isActive: true })
    .where(eq(transportConfigs.id, transportId));
  await db.update(tenants)
    .set({ settings: { postal_address: TEST_POSTAL } })
    .where(eq(tenants.id, tenantId));
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  for (const q of [
    sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM flow_memberships   WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM flows              WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM contacts           WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM transport_configs  WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM tenants            WHERE slug       = ${SLUG}`,
  ]) { await db.execute(q); }
}

async function makeContact(n: number): Promise<string> {
  const [r] = await db.insert(contacts).values({
    tenantId,
    externalId: `proof-${n}-${Date.now()}`,
    email: `proof${n}-${Date.now()}@example.com`,
    lifecycleState: "engaged",
    firstSeenAt: new Date("2026-01-01"),
    lastSeenAt: new Date("2026-01-01"),
  }).returning({ id: contacts.id });
  return r!.id;
}

async function makeFlow(windowPolicy: "immediate" | "respect_window" = "immediate"): Promise<string> {
  const [r] = await db.insert(flows).values({
    tenantId,
    name: `proof-flow-${Date.now()}`,
    priority: 0,
    triggerType: "lifecycle_transition",
    triggerConfig: { from: "engaged", to: "at_risk" },
    steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
    status: "paused",
    flowClass: "nurture",
    compiledPlan: {
      trigger: { type: "lifecycle_transition" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
    },
  }).returning({ id: flows.id });
  return r!.id;
}

async function makeMembership(contactId: string, flowId: string): Promise<string> {
  const [r] = await db.insert(flowMemberships).values({
    tenantId,
    contactId,
    flowId,
    currentStep: 1,
    status: "completed",
    enteredAt: new Date("2026-01-01"),
    completedAt: new Date("2026-01-01"),
    exitReason: "completed",
  }).returning({ id: flowMemberships.id });
  return r!.id;
}

async function makeApproved(contactId: string, flowId: string): Promise<string> {
  const membershipId = await makeMembership(contactId, flowId);
  const [r] = await db.insert(lifecycleMessages).values({
    tenantId,
    contactId,
    flowId,
    membershipId,
    flowStepOrder: 1,
    status: "approved",
    subject: "Proof subject",
    bodyHtml: "<p>proof</p>",
    bodyText: "proof",
    approvedAt: new Date(),
  }).returning({ id: lifecycleMessages.id });
  return r!.id;
}

async function byStatus(): Promise<Record<string, number>> {
  const rows = await db.execute<{ status: string; cnt: string }>(sql`
    SELECT status, COUNT(*)::text AS cnt FROM lifecycle_messages
    WHERE tenant_id = ${tenantId} GROUP BY status ORDER BY status
  `);
  const out: Record<string, number> = {};
  for (const r of rows.rows) out[r.status] = parseInt(r.cnt, 10);
  return out;
}

async function allRows(): Promise<Array<{ id: string; status: string; scheduled_send_at: Date | null }>> {
  const rows = await db.execute<{ id: string; status: string; scheduled_send_at: string | null }>(sql`
    SELECT id, status, scheduled_send_at FROM lifecycle_messages
    WHERE tenant_id = ${tenantId} ORDER BY created_at, id
  `);
  return rows.rows.map(r => ({
    id: r.id, status: r.status,
    scheduled_send_at: r.scheduled_send_at ? new Date(r.scheduled_send_at) : null,
  }));
}

function runProofDrain(a: TransportAdapter | null, now: Date, opts: { batchLimit?: number } = {}) {
  return makeDrainRunner(db, tenantId, a, TEST_SIGNING_KEY, TEST_BASE_URL)(now, opts);
}

// =============================================================================
// Proof 1: batch_size_per_tick
// =============================================================================

describe("Proof 1: batch_size_per_tick", () => {
  it("5 approved, batch=2 -> tick1: 2 sent 3 remain; tick2: 4 sent 1 remain; tick3: all 5 sent", async () => {
    if (!dbAvailable) return;
    const adapter = new LogAdapter();
    const flowId = await makeFlow("immediate");
    for (let i = 0; i < 5; i++) {
      const cId = await makeContact(i);
      await makeApproved(cId, flowId);
    }

    const before = await byStatus();
    console.log("\n[Proof1] BEFORE:", JSON.stringify(before));
    expect(before.approved).toBe(5);

    const now = new Date();

    const r1 = await runProofDrain(adapter, now, { batchLimit: 2 });
    const s1 = await byStatus();
    console.log("[Proof1] TICK1 (batch=2):", JSON.stringify(s1), " drain:", { sent: r1.sent, candidates: r1.candidatesFetched });
    expect(s1.sent ?? 0).toBe(2);
    expect(s1.approved).toBe(3);

    const r2 = await runProofDrain(adapter, now, { batchLimit: 2 });
    const s2 = await byStatus();
    console.log("[Proof1] TICK2 (batch=2):", JSON.stringify(s2), " drain:", { sent: r2.sent });
    expect(s2.sent ?? 0).toBe(4);
    expect(s2.approved).toBe(1);

    const r3 = await runProofDrain(adapter, now, { batchLimit: 2 });
    const s3 = await byStatus();
    console.log("[Proof1] TICK3 (batch=2):", JSON.stringify(s3), " drain:", { sent: r3.sent });
    expect(s3.sent ?? 0).toBe(5);
    expect(s3.approved ?? 0).toBe(0);

    const final = await allRows();
    console.log("[Proof1] FINAL ROWS:");
    for (const r of final) console.log(`  ${r.id.slice(0,8)} status=${r.status}`);
    expect(final.every(r => r.status === "sent")).toBe(true);
  });
});

// =============================================================================
// Proof 2: daily_limit
// =============================================================================

describe("Proof 2: daily_limit", () => {
  it("daily_limit=2, 4 approved -> 2 sent, 2 deferred with future scheduled_send_at; simulate next day -> 2 more sent", async () => {
    if (!dbAvailable) return;
    const adapter = new LogAdapter();
    const flowId = await makeFlow("immediate");
    await db.update(transportConfigs).set({ dailyLimit: 2 }).where(eq(transportConfigs.id, transportId));

    for (let i = 0; i < 4; i++) {
      const cId = await makeContact(i);
      await makeApproved(cId, flowId);
    }

    const before = await byStatus();
    console.log("\n[Proof2] BEFORE (daily_limit=2, 4 approved):", JSON.stringify(before));
    expect(before.approved).toBe(4);

    const now = new Date();
    const r1 = await runProofDrain(adapter, now, { batchLimit: 10 });
    const s1 = await byStatus();
    console.log("[Proof2] AFTER DRAIN:", JSON.stringify(s1), " drain:", { sent: r1.sent });
    expect(s1.sent ?? 0).toBe(2);
    expect(s1.approved).toBe(2);

    const rows = await allRows();
    const deferred = rows.filter(r => r.status === "approved");
    console.log("[Proof2] DEFERRED ROWS (must have future scheduled_send_at):");
    for (const r of deferred) {
      console.log(`  ${r.id.slice(0,8)} status=${r.status} scheduled_send_at=${r.scheduled_send_at?.toISOString() ?? "NULL"}`);
      expect(r.scheduled_send_at).not.toBeNull();
      expect(r.scheduled_send_at!.getTime()).toBeGreaterThan(now.getTime());
    }

    // Simulate next day: clear sent_at and reset all to approved
    await db.execute(sql`
      UPDATE lifecycle_messages
      SET status='approved', sent_at=NULL, scheduled_send_at=NULL, recipient_address=NULL, updated_at=NOW()
      WHERE tenant_id = ${tenantId}
    `);
    const reset = await byStatus();
    console.log("[Proof2] AFTER RESET (simulate next day):", JSON.stringify(reset));
    expect(reset.approved).toBe(4);

    const adapter2 = new LogAdapter();
    const r2 = await runProofDrain(adapter2, new Date(), { batchLimit: 10 });
    const s2 = await byStatus();
    console.log("[Proof2] AFTER 2ND DRAIN:", JSON.stringify(s2), " drain:", { sent: r2.sent });
    expect(s2.sent ?? 0).toBe(2);
    expect(s2.approved).toBe(2);
  });
});

// =============================================================================
// Proof 3: send_window
// =============================================================================

describe("Proof 3: send_window", () => {
  it("window 23:00-23:59 UTC, now=12:00 UTC -> deferred; open to 00:00-23:59 -> sent", async () => {
    if (!dbAvailable) return;
    const adapter = new LogAdapter();
    const flowId = await makeFlow("respect_window");
    const cId = await makeContact(0);
    await makeApproved(cId, flowId);

    await db.update(tenants).set({
      settings: {
        postal_address: TEST_POSTAL,
        throttle: {
          send_window_start: "23:00",
          send_window_end: "23:59",
          send_window_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          send_window_timezone: "tenant_fixed",
          tenant_timezone: "UTC",
        },
      },
    }).where(eq(tenants.id, tenantId));

    const before = await byStatus();
    console.log("\n[Proof3] BEFORE (window 23:00-23:59 UTC, now=12:00 UTC):", JSON.stringify(before));

    const outsideTime = new Date("2026-08-05T12:00:00Z");
    const r1 = await runProofDrain(adapter, outsideTime, { batchLimit: 10 });
    const s1 = await byStatus();
    const rows1 = await allRows();
    console.log("[Proof3] OUTSIDE WINDOW:", JSON.stringify(s1), " deferredWindow:", r1.deferredWindow, " sent:", r1.sent);
    for (const r of rows1) {
      console.log(`  ${r.id.slice(0,8)} status=${r.status} scheduled_send_at=${r.scheduled_send_at?.toISOString() ?? "NULL"}`);
    }
    expect(r1.deferredWindow).toBe(1);
    expect(r1.sent).toBe(0);
    expect(s1.approved).toBe(1);
    expect(rows1[0]!.scheduled_send_at).not.toBeNull();

    // Open window; clear scheduled_send_at so message is eligible
    await db.update(tenants).set({
      settings: {
        postal_address: TEST_POSTAL,
        throttle: {
          send_window_start: "00:00",
          send_window_end: "23:59",
          send_window_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          send_window_timezone: "tenant_fixed",
          tenant_timezone: "UTC",
        },
      },
    }).where(eq(tenants.id, tenantId));
    await db.execute(sql`
      UPDATE lifecycle_messages SET scheduled_send_at=NULL
      WHERE tenant_id=${tenantId} AND status='approved'
    `);

    const adapter2 = new LogAdapter();
    const r2 = await runProofDrain(adapter2, outsideTime, { batchLimit: 10 });
    const s2 = await byStatus();
    const rows2 = await allRows();
    console.log("[Proof3] INSIDE WINDOW (00:00-23:59):", JSON.stringify(s2), " sent:", r2.sent);
    for (const r of rows2) console.log(`  ${r.id.slice(0,8)} status=${r.status}`);
    expect(r2.sent).toBe(1);
    expect(s2.sent ?? 0).toBe(1);
  });
});
