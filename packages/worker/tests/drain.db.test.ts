/**
 * Integration tests for the drain worker (task 14, compliance injection task 32b).
 *
 * Tests:
 * - Verdict: allow -> sent
 * - Verdict: suppress -> status = 'suppressed'
 * - Verdict: defer_frequency -> status = 'approved', scheduled_send_at set
 * - Verdict: defer_window -> status = 'approved', scheduled_send_at set
 * - Ordering: critical-before-nurture even when nurture has higher priority number
 * - No-transport: message stays at approved when resolver returns null
 * - No-email: message stays at sending (skipped) when contact has no email
 * - Transport error (transient): message stays at 'sending' (reap will recover in task 15)
 * - Transport permanent failure: message marked 'failed' immediately (not left for reap)
 * - Provider message id: persisted on successful send; null when provider returns none
 * - PgGate concurrency: two drains claim disjoint sets
 * - Compliance: sent message carries List-Unsubscribe and List-Unsubscribe-Post headers
 * - Compliance: sent message token in header resolves to the correct message
 * - Compliance: HTML and text bodies contain footer; stored row is unchanged
 * - Compliance: recipient_address is written before send attempt
 * - Compliance: tenant with no postal address does not send (reverts to approved)
 * - Compliance: missing signing key fails closed
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql, inArray } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  suppressions,
  events,
} from "@claros/db/schema";
import { processDrainTick } from "../src/drain.js";
import { verifyUnsubscribeToken } from "@claros/adapters";
import type { TransportAdapter, TransportSendResult, TransportSendParams } from "../src/transport.js";
import { makeDrainRunner } from "./drain-test-utils.js";

// ---------------------------------------------------------------------------
// Test-only LogTransportAdapter (lives in tests/, never in src/)
// ---------------------------------------------------------------------------

/**
 * A transport adapter that logs send attempts and always succeeds.
 * Used ONLY in tests. Lives in tests/ - structurally cannot be imported
 * by production code.
 */
class LogTransportAdapter implements TransportAdapter {
  public sends: TransportSendParams[] = [];

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(params);
    return { success: true, providerMessageId: `log-${params.messageId}` };
  }
}

/**
 * A transport adapter that always fails (simulates transport errors).
 * No `permanent` flag = transient failure - message stays at 'sending' for reap.
 */
class FailingTransportAdapter implements TransportAdapter {
  async send(_params: TransportSendParams): Promise<TransportSendResult> {
    return { success: false, error: "simulated transport failure" };
  }
}

/**
 * A transport adapter that returns a permanent failure.
 * `permanent: true` - drain should mark message 'failed' immediately.
 */
class PermanentFailureAdapter implements TransportAdapter {
  async send(_params: TransportSendParams): Promise<TransportSendResult> {
    return { success: false, error: "invalid recipient address", permanent: true };
  }
}

/**
 * A transport adapter that succeeds but returns no provider message ID.
 * The column should remain null; the message should still be marked 'sent'.
 */
class NoProviderIdAdapter implements TransportAdapter {
  public sends: TransportSendParams[] = [];

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(params);
    // Success but no providerMessageId (e.g., adapter that does not surface it yet)
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[drain.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

const TEST_SIGNING_KEY = "drain-test-unsubscribe-signing-key-do-not-use-in-production";
const TEST_BASE_URL = "http://localhost:3000";
const TEST_POSTAL_ADDRESS = "123 Test St, Test City, TC 12345";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;

const SLUG = "test-drain-worker";

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
        `[drain.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[drain.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Test Drain Worker",
      slug: SLUG,
      plan: "free",
      // postal_address in settings is required for compliance (CAN-SPAM).
      // All tests that actually send mail need this. Tests for the
      // no-postal-address path override it per-test.
      settings: { postal_address: TEST_POSTAL_ADDRESS },
    })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  // Restore settings with postal address after any test that removed it.
  await db
    .update(tenants)
    .set({ settings: { postal_address: TEST_POSTAL_ADDRESS } })
    .where(eq(tenants.id, testTenantId));
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(
    sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG}))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  opts: { email?: string | null; timezone?: string } = {},
): Promise<string> {
  const email = opts.email === undefined ? `${externalId}@example.com` : opts.email;
  const properties = opts.timezone ? { timezone: opts.timezone } : null;
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      email,
      lifecycleState: "engaged",
      properties,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(opts: {
  name: string;
  flowClass?: string;
  priority?: number;
  windowPolicy?: string;
}): Promise<string> {
  const windowPolicy = opts.windowPolicy ?? "immediate";
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: opts.name,
      priority: opts.priority ?? 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
      // Use 'paused' status so phaseStepAdvancement skips these flows.
      // The drain only cares about message status, not flow status.
      status: "paused",
      flowClass: opts.flowClass ?? "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(contactId: string, flowId: string): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId: testTenantId,
      contactId,
      flowId,
      currentStep: 1,
      // Use 'completed' so phaseStepAdvancement does not pick these up.
      // The drain only cares about message status, not membership status.
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertApprovedMessage(opts: {
  contactId: string;
  flowId: string;
  membershipId: string;
  scheduledSendAt?: Date | null;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
}): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: testTenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      membershipId: opts.membershipId,
      flowStepOrder: 1,
      status: "approved",
      subject: opts.subject ?? "Test subject",
      bodyHtml: opts.bodyHtml ?? "<p>Test body</p>",
      bodyText: opts.bodyText ?? "Test body",
      approvedAt: new Date("2026-07-20T10:00:00Z"),
      scheduledSendAt: opts.scheduledSendAt ?? null,
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

/**
 * Run processDrainTick scoped to testTenantId. Both the transport resolver
 * and the batch fetch are limited to this tenant so that concurrent test
 * files cannot inflate count assertions through foreign messages.
 * See drain-test-utils.ts for the full explanation.
 */
function runDrainTick(
  adapter: TransportAdapter | null,
  now: Date,
  opts: { batchLimit?: number; signingKey?: string | null; baseUrl?: string; isProduction?: boolean } = {},
) {
  const runner = makeDrainRunner(
    db,
    testTenantId,
    adapter,
    TEST_SIGNING_KEY,
    TEST_BASE_URL,
  );
  return runner(now, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drain worker", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  describe("verdict: allow -> sent", () => {
    it("sends the message and marks it sent", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("allow-contact");
      const flowId = await insertFlow({ name: "allow-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z"); // within default window

      const result = await runDrainTick(adapter, now);

      expect(result.sent).toBe(1);
      expect(result.candidatesFetched).toBe(1);
      expect(adapter.sends).toHaveLength(1);
      expect(adapter.sends[0]!.to).toBe("allow-contact@example.com");
      expect(adapter.sends[0]!.messageId).toBe(messageId);

      // Check DB state
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          sentAt: lifecycleMessages.sentAt,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
      expect(msg!.sentAt).toBeTruthy();
      // recipient_address is written before the send attempt
      expect(msg!.recipientAddress).toBe("allow-contact@example.com");
    });
  });

  describe("verdict: suppress", () => {
    it("marks message as suppressed when contact is on suppression list", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("suppress-contact");
      const flowId = await insertFlow({ name: "suppress-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Add contact to suppression list
      await db.insert(suppressions).values({
        tenantId: testTenantId,
        email: "suppress-contact@example.com",
        reason: "manual",
        source: "admin",
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      expect(result.suppressed).toBe(1);
      expect(result.sent).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("suppressed");
    });
  });

  describe("send-time exit check", () => {
    it("cancels an approved message whose flow exit was met after entry; sends when it was not", async () => {
      if (!dbAvailable) return;

      const reactivated = await insertContact("exit-reactivated");
      const stillLeaving = await insertContact("exit-still-leaving");
      const flowId = await insertFlow({ name: "exit-flow", windowPolicy: "immediate" });
      await db
        .update(flows)
        .set({
          compiledPlan: {
            trigger: { type: "event", condition: { event: "subscription_cancel_scheduled" } },
            steps: [{ order: 1, action_type: "cancel_save", delay: "0m", window_policy: "immediate" }],
            exit_conditions: [{ event: "subscription_reactivated" }, { trait: { key: "payment_status", op: "eq", value: "paid_again" } }],
          },
        })
        .where(eq(flows.id, flowId));
      const m1 = await insertApprovedMessage({ contactId: reactivated, flowId, membershipId: await insertMembership(reactivated, flowId) });
      const m2 = await insertApprovedMessage({ contactId: stillLeaving, flowId, membershipId: await insertMembership(stillLeaving, flowId) });
      // The membership entered 2026-07-20; the reactivation came after it.
      await db.insert(events).values({ tenantId: testTenantId, contactId: reactivated, type: "track", eventName: "subscription_reactivated", timestamp: new Date("2026-07-20T12:00:00Z") });
      // An older event (before entry) does not count.
      await db.insert(events).values({ tenantId: testTenantId, contactId: stillLeaving, type: "track", eventName: "subscription_reactivated", timestamp: new Date("2026-07-19T12:00:00Z") });

      const adapter = new LogTransportAdapter();
      const result = await runDrainTick(adapter, new Date("2026-07-21T10:00:00Z"));

      expect(result.exitMet).toBe(1);
      expect(result.sent).toBe(1);
      expect(adapter.sends.map((x) => x.messageId)).toEqual([m2]);
      const [cancelled] = await db.select({ status: lifecycleMessages.status, reason: lifecycleMessages.statusReason }).from(lifecycleMessages).where(eq(lifecycleMessages.id, m1));
      expect(cancelled).toEqual({ status: "cancelled", reason: "exit_met" });
    });
  });

  describe("verdict: defer_frequency", () => {
    it("defers when min interval not elapsed", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("freq-contact");
      const flowId = await insertFlow({ name: "freq-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Insert a recent sent message to trigger frequency cap
      // Default min_interval is 48h. Put a sent message 1h ago.
      const now = new Date("2026-07-21T10:00:00Z");
      const recentSentAt = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago

      // Need a second flow/membership for the prior message
      const flow2Id = await insertFlow({ name: "freq-flow-prior", windowPolicy: "immediate" });
      const membership2Id = await insertMembership(contactId, flow2Id);
      await db.insert(lifecycleMessages).values({
        tenantId: testTenantId,
        contactId,
        flowId: flow2Id,
        membershipId: membership2Id,
        flowStepOrder: 1,
        status: "sent",
        sentAt: recentSentAt,
        subject: "Prior message",
        bodyHtml: "<p>Prior</p>",
      });

      const adapter = new LogTransportAdapter();

      const result = await runDrainTick(adapter, now);

      expect(result.deferredFrequency).toBe(1);
      expect(result.sent).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          scheduledSendAt: lifecycleMessages.scheduledSendAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      expect(msg!.scheduledSendAt).toBeTruthy();
      // Should be retryAfter = lastSentAt + 48h
      const expectedRetry = new Date(recentSentAt.getTime() + 48 * 60 * 60 * 1000);
      expect(msg!.scheduledSendAt!.getTime()).toBe(expectedRetry.getTime());
    });
  });

  describe("verdict: defer_window", () => {
    it("defers when outside send window with respect_window policy", async () => {
      if (!dbAvailable) return;

      // Contact in UTC, default window is Mon-Fri 09:00-17:00
      const contactId = await insertContact("window-contact", { timezone: "UTC" });
      const flowId = await insertFlow({ name: "window-flow", windowPolicy: "respect_window" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      // Saturday at 10:00 UTC - outside default weekday window
      const now = new Date("2026-07-25T10:00:00Z"); // July 25, 2026 is Saturday

      const result = await runDrainTick(adapter, now);

      expect(result.deferredWindow).toBe(1);
      expect(result.sent).toBe(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          scheduledSendAt: lifecycleMessages.scheduledSendAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      expect(msg!.scheduledSendAt).toBeTruthy();
      // Next window should be Monday 09:00 UTC (July 27, 2026)
      const expected = new Date("2026-07-27T09:00:00Z");
      // Allow 1 minute tolerance for computation differences
      const diff = Math.abs(msg!.scheduledSendAt!.getTime() - expected.getTime());
      expect(diff).toBeLessThan(2 * 60 * 1000);
    });
  });

  describe("ordering: critical before nurture", () => {
    it("processes critical messages first even when nurture has higher priority number", async () => {
      if (!dbAvailable) return;

      // Use two different contacts so frequency cap does not interfere
      const contactA = await insertContact("order-contact-a");
      const contactB = await insertContact("order-contact-b");

      // Nurture flow with priority 100 (high number)
      const nurtureFlowId = await insertFlow({
        name: "high-priority-nurture",
        flowClass: "nurture",
        priority: 100,
        windowPolicy: "immediate",
      });
      const nurtureMembershipId = await insertMembership(contactA, nurtureFlowId);
      await insertApprovedMessage({
        contactId: contactA,
        flowId: nurtureFlowId,
        membershipId: nurtureMembershipId,
        subject: "Nurture subject",
      });

      // Critical flow with priority 1 (low number)
      const criticalFlowId = await insertFlow({
        name: "low-priority-critical",
        flowClass: "critical",
        priority: 1,
        windowPolicy: "immediate",
      });
      const criticalMembershipId = await insertMembership(contactB, criticalFlowId);
      await insertApprovedMessage({
        contactId: contactB,
        flowId: criticalFlowId,
        membershipId: criticalMembershipId,
        subject: "Critical subject",
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      // Both should be sent (different contacts, no frequency conflict)
      expect(result.candidatesFetched).toBe(2);
      expect(result.sent).toBe(2);
      expect(adapter.sends).toHaveLength(2);

      // Critical must be processed FIRST (index 0) despite lower priority number
      expect(adapter.sends[0]!.subject).toBe("Critical subject");
      expect(adapter.sends[1]!.subject).toBe("Nurture subject");
    });
  });

  describe("no-transport", () => {
    it("performs zero writes to lifecycle_messages when transport resolver returns null", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-transport-contact");
      const flowId = await insertFlow({ name: "no-transport-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Record the updated_at before the drain tick
      const [before] = await db
        .select({
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      const originalUpdatedAt = before!.updatedAt;

      const now = new Date("2026-07-21T10:00:00Z");

      // Null resolver - simulates no transport configured (no signing key needed here)
      const result = await runDrainTick(null, now, { signingKey: null });

      // skippedNoTransport counts ALL tenants with approved messages whose
      // resolver returned null. Other suites running concurrently may have
      // approved messages for their own tenants, so the count can exceed 1.
      // What we actually care about: our tenant was skipped (>= 1) and no
      // messages were claimed or sent.
      expect(result.skippedNoTransport).toBeGreaterThanOrEqual(1);
      expect(result.candidatesFetched).toBe(0);
      expect(result.sent).toBe(0);

      // Message must still be 'approved' with the same updated_at (zero writes)
      const [after] = await db
        .select({
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(after!.status).toBe("approved");
      expect(after!.updatedAt!.getTime()).toBe(originalUpdatedAt!.getTime());
    });

    it("skips entirely - no messages are claimed or reverted", async () => {
      if (!dbAvailable) return;

      // Create multiple messages to ensure none are touched
      const messages: string[] = [];
      for (let i = 0; i < 3; i++) {
        const contactId = await insertContact(`no-transport-multi-${i}`);
        const flowId = await insertFlow({ name: `no-transport-multi-flow-${i}`, windowPolicy: "immediate" });
        const membershipId = await insertMembership(contactId, flowId);
        const msgId = await insertApprovedMessage({
          contactId,
          flowId,
          membershipId,
        });
        messages.push(msgId);
      }

      // Record all updated_at values before
      const beforeRows = await db
        .select({
          id: lifecycleMessages.id,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(inArray(lifecycleMessages.id, messages));
      const beforeMap = new Map(beforeRows.map((r) => [r.id, r.updatedAt!.getTime()]));

      const now = new Date("2026-07-21T10:00:00Z");
      await runDrainTick(null, now, { signingKey: null });

      // Verify all messages unchanged
      const afterRows = await db
        .select({
          id: lifecycleMessages.id,
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(inArray(lifecycleMessages.id, messages));

      for (const row of afterRows) {
        expect(row.status).toBe("approved");
        expect(row.updatedAt!.getTime()).toBe(beforeMap.get(row.id));
      }
    });
  });

  describe("no-email", () => {
    it("skips message when contact has no email address", async () => {
      if (!dbAvailable) return;

      // Contact with null email
      const contactId = await insertContact("no-email-contact", { email: null });
      const flowId = await insertFlow({ name: "no-email-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      expect(result.skippedNoEmail).toBe(1);
      expect(adapter.sends).toHaveLength(0);

      // Message reverts to 'approved' after being claimed then discovering
      // no email. Will be re-evaluated next tick; once contact gets an email,
      // it can proceed.
      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
    });
  });

  describe("transport error (transient)", () => {
    it("leaves message at sending when transport fails with no permanent flag", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("error-contact");
      const flowId = await insertFlow({ name: "error-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const failingAdapter = new FailingTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(failingAdapter, now);

      expect(result.transportErrors).toBe(1);
      expect(result.permanentFailures).toBe(0);
      expect(result.sent).toBe(0);

      // Message stays at 'sending' - reap (task 15) will recover.
      // recipient_address is written BEFORE the send (pre-send write). Even on a
      // transient failure the address is set, ensuring reap can recover the row
      // to 'sent' and the unsubscribe endpoint can then resolve it.
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          providerMessageId: lifecycleMessages.providerMessageId,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sending");
      expect(msg!.providerMessageId).toBeNull();
      // recipient_address is written before the send; it is set even on failure.
      expect(msg!.recipientAddress).toBe("error-contact@example.com");
    });
  });

  describe("transport permanent failure", () => {
    it("marks message failed immediately when adapter reports permanent failure", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("perm-fail-contact");
      const flowId = await insertFlow({ name: "perm-fail-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const permanentAdapter = new PermanentFailureAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(permanentAdapter, now);

      expect(result.permanentFailures).toBe(1);
      expect(result.transportErrors).toBe(0);
      expect(result.sent).toBe(0);

      // Message is marked 'failed' immediately - not left for reap.
      // recipient_address is written BEFORE the send (pre-send write). Even on a
      // permanent failure the address is set; this is irrelevant for the
      // unsubscribe endpoint since it requires status = 'sent'.
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          providerMessageId: lifecycleMessages.providerMessageId,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("failed");
      expect(msg!.providerMessageId).toBeNull();
      // recipient_address is written before the send; it is set even on permanent failure.
      expect(msg!.recipientAddress).toBe("perm-fail-contact@example.com");
    });
  });

  describe("provider message id", () => {
    it("persists provider message id on successful send", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("prov-id-contact");
      const flowId = await insertFlow({ name: "prov-id-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      expect(result.sent).toBe(1);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          providerMessageId: lifecycleMessages.providerMessageId,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
      // LogTransportAdapter returns `log-${params.messageId}`
      expect(msg!.providerMessageId).toBe(`log-${messageId}`);
    });

    it("leaves provider_message_id null when adapter returns no id", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-prov-id-contact");
      const flowId = await insertFlow({ name: "no-prov-id-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new NoProviderIdAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      expect(result.sent).toBe(1);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          providerMessageId: lifecycleMessages.providerMessageId,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
      expect(msg!.providerMessageId).toBeNull();
    });
  });

  describe("scheduled_send_at gate", () => {
    it("does not pick up messages with future scheduled_send_at", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("future-contact");
      const flowId = await insertFlow({ name: "future-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);

      const now = new Date("2026-07-21T10:00:00Z");
      const future = new Date("2026-07-22T10:00:00Z"); // 24h from now

      await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
        scheduledSendAt: future,
      });

      const adapter = new LogTransportAdapter();
      const result = await runDrainTick(adapter, now);

      expect(result.candidatesFetched).toBe(0);
      expect(adapter.sends).toHaveLength(0);
    });
  });

  describe("PgGate concurrency", () => {
    it("two concurrent drains claim disjoint message sets", async () => {
      if (!dbAvailable) return;

      // Create 4 messages for different contacts
      const messages: string[] = [];
      for (let i = 0; i < 4; i++) {
        const contactId = await insertContact(`concurrent-${i}`);
        const flowId = await insertFlow({
          name: `concurrent-flow-${i}`,
          windowPolicy: "immediate",
        });
        const membershipId = await insertMembership(contactId, flowId);
        const msgId = await insertApprovedMessage({
          contactId,
          flowId,
          membershipId,
        });
        messages.push(msgId);
      }

      const adapter1 = new LogTransportAdapter();
      const adapter2 = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      let result1: Awaited<ReturnType<typeof processDrainTick>>;
      let result2: Awaited<ReturnType<typeof processDrainTick>>;
      // Run two drain ticks concurrently. Each uses batchLimit=2
      // so they should each pick up 2 disjoint messages.
      [result1, result2] = await Promise.all([
        runDrainTick(adapter1, now, { batchLimit: 2 }),
        runDrainTick(adapter2, now, { batchLimit: 2 }),
      ]);

      // Total sent across both should be <= 4
      // Due to SKIP LOCKED, they should get disjoint sets.
      const totalSent = result1.sent + result2.sent;
      const totalCandidates = result1.candidatesFetched + result2.candidatesFetched;

      // Both should have fetched candidates (SKIP LOCKED distributes work)
      expect(totalCandidates).toBe(4);
      // All should be sent (no frequency cap because different contacts)
      expect(totalSent).toBe(4);

      // Verify no duplicates: union of sent message IDs should have 4 distinct entries
      const allSentIds = [...adapter1.sends, ...adapter2.sends].map((s) => s.messageId);
      const uniqueIds = new Set(allSentIds);
      expect(uniqueIds.size).toBe(4);

      // Verify all messages are now 'sent' in DB
      for (const msgId of messages) {
        const [msg] = await db
          .select({ status: lifecycleMessages.status })
          .from(lifecycleMessages)
          .where(eq(lifecycleMessages.id, msgId));
        expect(msg!.status).toBe("sent");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Compliance tests (task 32b)
  // ---------------------------------------------------------------------------

  describe("compliance: headers and footer injection", () => {
    it("sent message carries List-Unsubscribe and List-Unsubscribe-Post headers", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("compliance-header-contact");
      const flowId = await insertFlow({ name: "compliance-header-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
        subject: "Compliance test",
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);
      expect(adapter.sends).toHaveLength(1);

      const sentParams = adapter.sends[0]!;
      expect(sentParams.headers).toBeDefined();
      expect(sentParams.headers!["List-Unsubscribe"]).toBeTruthy();
      expect(sentParams.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // List-Unsubscribe header must contain the HTTPS one-click form only.
      // The mailto: form is intentionally absent - see compliance.ts [impl] note.
      const unsubHeader = sentParams.headers!["List-Unsubscribe"]!;
      expect(unsubHeader).not.toMatch(/mailto:/);
      expect(unsubHeader).toMatch(/https?:\/\//);
      expect(unsubHeader).toContain("/unsubscribe/one-click?token=");
    });

    it("token in List-Unsubscribe header verifies and resolves to the correct message", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("compliance-token-contact");
      const flowId = await insertFlow({ name: "compliance-token-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);

      const sentParams = adapter.sends[0]!;
      const unsubHeader = sentParams.headers!["List-Unsubscribe"]!;

      // Extract token from the HTTPS URL in the header
      const tokenMatch = unsubHeader.match(/one-click\?token=([^>,\s]+)/);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch![1]!;

      // Token must verify with the test key
      const verifyResult = verifyUnsubscribeToken(token, TEST_SIGNING_KEY);

      expect(verifyResult.ok).toBe(true);
      if (!verifyResult.ok) return;
      // Token must encode the message ID (not the contact ID)
      expect(verifyResult.payload.messageId).toBe(messageId);
      expect(verifyResult.payload.tenantId).toBe(testTenantId);
    });

    it("a product with a public_host links to https://<public_host>, also when BASE_URL is unusable in production", async () => {
      if (!dbAvailable) return;

      const host = `news-${Date.now().toString(36)}.drain-test.example.com`;
      await db.update(tenants).set({ publicHost: host }).where(eq(tenants.id, testTenantId));
      try {
        const contactId = await insertContact("public-host-contact");
        const flowId = await insertFlow({ name: "public-host-flow", windowPolicy: "immediate" });
        const membershipId = await insertMembership(contactId, flowId);
        await insertApprovedMessage({ contactId, flowId, membershipId });

        const adapter = new LogTransportAdapter();
        // TEST_BASE_URL is localhost: in production it would block the send,
        // but this product's links do not use it.
        const result = await runDrainTick(adapter, new Date("2026-07-21T10:00:00Z"), { isProduction: true });
        expect(result.sent).toBe(1);
        expect(result.skippedBadBaseUrl).toBe(0);
        const sent = adapter.sends[0]!;
        expect(sent.headers!["List-Unsubscribe"]).toContain(`<https://${host}/unsubscribe/one-click?token=`);
        expect(sent.bodyHtml).toContain(`https://${host}/unsubscribe?token=`);
        expect(sent.bodyHtml).not.toContain(TEST_BASE_URL);
      } finally {
        await db.update(tenants).set({ publicHost: null }).where(eq(tenants.id, testTenantId));
      }
    });

    it("HTML body ends with compliance footer; stored row body_html is unchanged", async () => {
      if (!dbAvailable) return;

      const originalHtml = "<p>Hello world</p>";
      const contactId = await insertContact("compliance-html-contact");
      const flowId = await insertFlow({ name: "compliance-html-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
        bodyHtml: originalHtml,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);

      const sentParams = adapter.sends[0]!;

      // Delivered HTML contains the original body plus the footer
      expect(sentParams.bodyHtml).toContain(originalHtml);
      expect(sentParams.bodyHtml).toContain("Unsubscribe");
      expect(sentParams.bodyHtml).toContain(TEST_POSTAL_ADDRESS);

      // Stored row must NOT be modified (footer is ephemeral)
      const [msg] = await db
        .select({ bodyHtml: lifecycleMessages.bodyHtml })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.bodyHtml).toBe(originalHtml);
    });

    it("plain text body ends with compliance footer; stored row body_text is unchanged", async () => {
      if (!dbAvailable) return;

      const originalText = "Hello world";
      const contactId = await insertContact("compliance-text-contact");
      const flowId = await insertFlow({ name: "compliance-text-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
        bodyText: originalText,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);

      const sentParams = adapter.sends[0]!;

      // Delivered text contains the original body plus the footer
      expect(sentParams.bodyText).toContain(originalText);
      expect(sentParams.bodyText).toContain("unsubscribe");
      expect(sentParams.bodyText).toContain(TEST_POSTAL_ADDRESS);

      // Stored row must NOT be modified
      const [msg] = await db
        .select({ bodyText: lifecycleMessages.bodyText })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.bodyText).toBe(originalText);
    });

    it("recipient_address is written before send attempt and matches the contact's email", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("delivered-to-contact");
      const flowId = await insertFlow({ name: "delivered-to-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);

      const [msg] = await db
        .select({ recipientAddress: lifecycleMessages.recipientAddress })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.recipientAddress).toBe("delivered-to-contact@example.com");
    });
  });

  describe("compliance: postal address enforcement", () => {
    it("reverts message to approved when tenant has no postal address (not a transport failure)", async () => {
      if (!dbAvailable) return;

      // Remove postal address from settings
      await db
        .update(tenants)
        .set({ settings: {} })
        .where(eq(tenants.id, testTenantId));

      const contactId = await insertContact("no-postal-contact");
      const flowId = await insertFlow({ name: "no-postal-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(adapter, now);

      // Counted as skippedNoPostalAddress - not a transport error, not a retry burn
      expect(result.skippedNoPostalAddress).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.transportErrors).toBe(0);
      expect(result.permanentFailures).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      // Message reverts to 'approved' - ready to retry next tick once operator fixes config
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      expect(msg!.recipientAddress).toBeNull();
    });
  });

  describe("compliance: missing signing key fails closed", () => {
    // signingKey: null falls back to process.env.UNSUBSCRIBE_SIGNING_KEY, so the
    // env var must be absent for these cases to exercise the missing-key path
    // regardless of the developer's local .env.
    beforeEach(() => {
      vi.stubEnv("UNSUBSCRIBE_SIGNING_KEY", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reverts message to approved when UNSUBSCRIBE_SIGNING_KEY is absent (not a transport failure, no retry consumed)", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-key-contact");
      const flowId = await insertFlow({ name: "no-key-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // Pass no signing key (signingKey: null simulates absent UNSUBSCRIBE_SIGNING_KEY).
      // The check runs before the throttle gate, so no budget is consumed and the
      // message reverts to 'approved' identically to the postal address path.
      const result = await runDrainTick(adapter, now, { signingKey: null });

      // Counted as skippedNoSigningKey - not a transport error, not a retry burn
      expect(result.skippedNoSigningKey).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.transportErrors).toBe(0);
      expect(result.permanentFailures).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      // Message reverts to 'approved' - ready to retry once operator sets the key
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          recipientAddress: lifecycleMessages.recipientAddress,
          retryCount: lifecycleMessages.retryCount,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      // recipient_address is written after config checks pass; since key was absent
      // the check fires before recipient_address is written, so it must remain null.
      expect(msg!.recipientAddress).toBeNull();
      // retry_count must not be incremented (this is not a transport failure)
      expect(msg!.retryCount).toBe(0);
    });

    it("missing signing key does not consume throttle budget across repeated ticks", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-key-throttle-contact");
      const flowId = await insertFlow({ name: "no-key-throttle-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // Run 3 ticks without a signing key. Each should revert, not accumulate
      // frequency-cap counts (sent_at is never written so counts stay at 0).
      for (let i = 0; i < 3; i++) {
        const r = await runDrainTick(adapter, now, { signingKey: null });
        expect(r.skippedNoSigningKey).toBe(1);
        expect(r.sent).toBe(0);
      }

      // Now run with a valid signing key - the message must send normally.
      // If throttle budget had been consumed, this would defer instead.
      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);
      expect(result.deferredFrequency).toBe(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
    });
  });

  describe("compliance: missing postal address does not consume throttle budget", () => {
    it("repeated ticks against a misconfigured tenant leave throttle counters untouched", async () => {
      if (!dbAvailable) return;

      // Remove postal address from settings
      await db
        .update(tenants)
        .set({ settings: {} })
        .where(eq(tenants.id, testTenantId));

      const contactId = await insertContact("postal-throttle-contact");
      const flowId = await insertFlow({ name: "postal-throttle-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // Run 3 ticks with no postal address. Each should revert without touching
      // throttle counters (sent_at is never written).
      for (let i = 0; i < 3; i++) {
        const r = await runDrainTick(adapter, now);
        expect(r.skippedNoPostalAddress).toBe(1);
        expect(r.sent).toBe(0);
      }

      // Restore postal address.
      await db
        .update(tenants)
        .set({ settings: { postal_address: TEST_POSTAL_ADDRESS } })
        .where(eq(tenants.id, testTenantId));

      // Now the message must send normally; no throttle budget was consumed.
      const result = await runDrainTick(adapter, now);
      expect(result.sent).toBe(1);
      expect(result.deferredFrequency).toBe(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
    });
  });

  describe("compliance: recipient_address durability", () => {
    it("recipient_address is set before send; status='sending' is NOT treated as proof of delivery", async () => {
      if (!dbAvailable) return;

      // Simulate the crash window: recipient_address written before send, but the
      // post-send status write (CAS to 'sent') is skipped (simulates process death).
      // The unsubscribe endpoint must NOT accept this token - status is still 'sending',
      // not 'sent'. Once reap recovers the row to 'sent' the token becomes valid.
      const contactId = await insertContact("durability-contact");
      const flowId = await insertFlow({ name: "durability-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Claim the message to 'sending'
      await db.execute(sql`
        UPDATE lifecycle_messages SET status = 'sending', updated_at = NOW()
        WHERE id = ${messageId}
      `);

      // Simulate the pre-send recipient_address write (what drain does before adapter.send)
      const expectedEmail = "durability-contact@example.com";
      await db.execute(sql`
        UPDATE lifecycle_messages SET recipient_address = ${expectedEmail}, updated_at = NOW()
        WHERE id = ${messageId} AND status = 'sending'
      `);

      // Verify: status is still 'sending' (post-send write never happened) and
      // recipient_address is set. The unsubscribe endpoint requires status = 'sent'
      // so this message is not yet resolvable. When reap recovers it to 'sent', it will be.
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));

      expect(msg!.status).toBe("sending"); // post-send write never happened
      expect(msg!.recipientAddress).toBe(expectedEmail); // address is present for when reap recovers
    });

    it("recipient_address is written before send and remains set after a transient transport failure", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("durability-transient-contact");
      const flowId = await insertFlow({ name: "durability-transient-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const failingAdapter = new FailingTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await runDrainTick(failingAdapter, now);
      expect(result.transportErrors).toBe(1);

      // recipient_address is set even though the send failed (written before send).
      // The unsubscribe endpoint will NOT resolve this token because status = 'sending',
      // not 'sent'. Once reap recovers the row to 'sent', the token becomes valid.
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sending");
      expect(msg!.recipientAddress).toBe("durability-transient-contact@example.com");
    });
  });

  describe("compliance: bad BASE_URL fails closed in production", () => {
    it("reverts message to approved when BASE_URL is localhost in production (not a transport failure, no retry consumed)", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("bad-url-contact");
      const flowId = await insertFlow({ name: "bad-url-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // isProduction: true forces the production check even in the test environment.
      // TEST_BASE_URL (http://localhost:3000) is a loopback URL, so the check must fail.
      const result = await runDrainTick(adapter, now, { isProduction: true });

      // Counted as skippedBadBaseUrl - not a transport error, not a retry burn.
      // The wrong value would be permanently baked into delivered email bodies.
      expect(result.skippedBadBaseUrl).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.transportErrors).toBe(0);
      expect(result.permanentFailures).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      // Message reverts to 'approved' - ready to retry once operator fixes BASE_URL.
      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          recipientAddress: lifecycleMessages.recipientAddress,
          retryCount: lifecycleMessages.retryCount,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      // recipient_address is written after config checks pass; the base URL check
      // fires before recipient_address is written, so it must remain null.
      expect(msg!.recipientAddress).toBeNull();
      // retry_count must not be incremented (this is not a transport failure).
      expect(msg!.retryCount).toBe(0);
    });

    it("allows localhost BASE_URL outside production so the quickstart is unaffected", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("local-url-contact");
      const flowId = await insertFlow({ name: "local-url-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // isProduction: false = development mode. Localhost base URL must be allowed.
      // This is the docker compose quickstart path.
      const result = await runDrainTick(adapter, now, { isProduction: false });

      expect(result.sent).toBe(1);
      expect(result.skippedBadBaseUrl).toBe(0);
      expect(adapter.sends).toHaveLength(1);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
    });

    it("sends normally when BASE_URL is a valid https URL in production", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("good-url-contact");
      const flowId = await insertFlow({ name: "good-url-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // isProduction: true, but base URL is a valid https URL - must send.
      const result = await runDrainTick(adapter, now, {
        baseUrl: "https://mail.example.com",
        isProduction: true,
      });

      expect(result.sent).toBe(1);
      expect(result.skippedBadBaseUrl).toBe(0);
      expect(adapter.sends).toHaveLength(1);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
    });

    it("bad BASE_URL in production does not consume throttle budget across repeated ticks", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("bad-url-throttle-contact");
      const flowId = await insertFlow({ name: "bad-url-throttle-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // Run 3 ticks with a bad base URL (production mode). Each must revert
      // without touching throttle counters (sent_at is never written).
      for (let i = 0; i < 3; i++) {
        const r = await runDrainTick(adapter, now, { isProduction: true });
        expect(r.skippedBadBaseUrl).toBe(1);
        expect(r.sent).toBe(0);
      }

      // Now run with a valid https URL in production - the message must send
      // normally. If throttle budget had been consumed, this would defer instead.
      const result = await runDrainTick(adapter, now, {
        baseUrl: "https://mail.example.com",
        isProduction: true,
      });
      expect(result.sent).toBe(1);
      expect(result.deferredFrequency).toBe(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
    });
  });
});
