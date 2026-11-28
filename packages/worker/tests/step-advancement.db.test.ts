/**
 * Integration tests for step advancement (task 12c).
 *
 * Tests:
 * - Normal advancement: delay elapsed, message created, step advanced
 * - Completion: last step message created, membership completed
 * - Delay not yet elapsed: no action
 * - Crash idempotency: message exists but step not advanced - retry succeeds
 * - Flow archived: membership exited with flow_archived
 * - Flow paused: membership skipped
 * - Null compiled_plan: membership skipped
 * - Checkpoint resume: batch partially processed, next run continues
 * - Stale checkpoint discard with discard_count increment
 *
 * PgGate concurrency tests:
 * - Two scans advancing the same membership: exactly one advance
 * - Membership advancing while an ingest-driven lifecycle transition fires
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  events,
  flows,
  flowMemberships,
  lifecycleMessages,
  scanCheckpoints,
} from "@claros/db/schema";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[step-advancement.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-step-advancement";

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
        `[step-advancement.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[step-advancement.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Step Advancement", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(
    sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${testTenantId}`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`,
    );
  await db.execute(
    sql`DELETE FROM scan_checkpoints WHERE tenant_id = ${testTenantId}`,
  );
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
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
    sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
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

async function insertContact(externalId: string, lifecycleState = "engaged"): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      lifecycleState,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

interface FlowOpts {
  name: string;
  steps: unknown[];
  status?: string;
  compiledPlan?: unknown | null;
  exitConditions?: unknown[];
}

async function insertFlow(opts: FlowOpts): Promise<string> {
  let compiledPlan: unknown;
  if (opts.compiledPlan === undefined) {
    compiledPlan = {
      trigger: { type: "lifecycle_transition", condition: {} },
      steps: opts.steps,
      ...(opts.exitConditions ? { exit_conditions: opts.exitConditions } : {}),
    };
  } else {
    compiledPlan = opts.compiledPlan;
  }

  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: opts.name,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: opts.steps,
      status: opts.status ?? "active",
      compileStatus: compiledPlan !== null ? "ready" : null,
      compiledPlan,
      approvalMode: "require",
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(opts: {
  contactId: string;
  flowId: string;
  currentStep?: number;
  enteredAt: Date;
}): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId: testTenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      currentStep: opts.currentStep ?? 1,
      status: "active",
      enteredAt: opts.enteredAt,
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function getMessages(membershipId: string) {
  return db
    .select()
    .from(lifecycleMessages)
    .where(eq(lifecycleMessages.membershipId, membershipId));
}

async function getMembership(membershipId: string) {
  const rows = await db
    .select()
    .from(flowMemberships)
    .where(eq(flowMemberships.id, membershipId));
  return rows[0] ?? null;
}

async function insertEvent(contactId: string, eventName: string, timestamp: Date): Promise<string> {
  const [row] = await db
    .insert(events)
    .values({
      tenantId: testTenantId,
      contactId,
      type: "track",
      eventName,
      timestamp,
    })
    .returning({ id: events.id });
  return row!.id;
}

async function updateContactState(contactId: string, state: string): Promise<void> {
  await db
    .update(contacts)
    .set({ lifecycleState: state })
    .where(eq(contacts.id, contactId));
}

// ---------------------------------------------------------------------------
// Basic step advancement tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - normal advancement", () => {
  it("creates a message and advances step when delay has elapsed", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("advance_basic");
    const flowId = await insertFlow({
      name: "Two-step flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "1d", window_policy: "respect_window" },
        { order: 2, action_type: "nurture_reactivate", delay: "3d", window_policy: "respect_window" },
      ],
    });

    // Membership entered 2 days ago (step 1 delay = 1d, so it should fire)
    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.stepsAdvanced).toBe(1);

    // Check message was created
    const messages = await getMessages(membershipId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.flowStepOrder).toBe(1);
    expect(messages[0]!.status).toBe("pending_generation");
    expect(messages[0]!.brainActionType).toBe("nurture_value");
    expect(messages[0]!.flowId).toBe(flowId);
    expect(messages[0]!.contactId).toBe(contactId);

    // Check membership was advanced
    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(2);
    expect(membership!.status).toBe("active");
  });

  it("does not advance when delay has not elapsed", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("advance_not_elapsed");
    const flowId = await insertFlow({
      name: "Long-delay flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "7d", window_policy: "respect_window" },
      ],
    });

    // Membership entered 2 days ago, but delay is 7 days
    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(0);
    expect(result.stepsAdvanced).toBe(0);

    const messages = await getMessages(membershipId);
    expect(messages).toHaveLength(0);

    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(1);
  });

  it("uses previous message created_at for step N delay (not entered_at)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("advance_step_n");
    const flowId = await insertFlow({
      name: "Multi-step",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
        { order: 2, action_type: "follow_up", delay: "2d", window_policy: "respect_window" },
      ],
    });

    // Membership entered 10 days ago, currently at step 2
    const enteredAt = new Date("2026-07-10T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 2,
      enteredAt,
    });

    // Step 1 message was created 1 day ago (within the 2-day delay of step 2)
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "sent",
      brainActionType: "welcome",
      createdAt: new Date("2026-07-19T12:00:00Z"),
    });

    // Now = Jul 20 12:00, step 1 message created Jul 19 12:00.
    // Step 2 delay = 2d. Elapsed = 1d. Should NOT advance.
    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(0);
    expect(result.stepsAdvanced).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(2);
  });

  it("advances step N when delay from previous message has elapsed", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("advance_step_n_elapsed");
    const flowId = await insertFlow({
      name: "Multi-step elapsed",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
        { order: 2, action_type: "follow_up", delay: "2d", window_policy: "respect_window" },
        { order: 3, action_type: "final", delay: "1d", window_policy: "respect_window" },
      ],
    });

    const enteredAt = new Date("2026-07-10T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 2,
      enteredAt,
    });

    // Step 1 message was created 3 days ago (step 2 delay = 2d, elapsed = 3d)
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "sent",
      brainActionType: "welcome",
      createdAt: new Date("2026-07-17T12:00:00Z"),
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.stepsAdvanced).toBe(1);

    const messages = await getMessages(membershipId);
    const step2Msg = messages.find((m) => m.flowStepOrder === 2);
    expect(step2Msg).toBeDefined();
    expect(step2Msg!.status).toBe("pending_generation");
    expect(step2Msg!.brainActionType).toBe("follow_up");

    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(3);
  });

  it("handles zero-delay steps (immediate fire)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("advance_zero_delay");
    const flowId = await insertFlow({
      name: "Immediate flow",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
      ],
    });

    // Just enrolled (entered_at = now)
    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);

    const messages = await getMessages(membershipId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.status).toBe("pending_generation");

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("completed");
    expect(membership!.exitReason).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Completion tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - membership completion", () => {
  it("completes membership after the last step fires", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("complete_last_step");
    const flowId = await insertFlow({
      name: "Single-step flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "1d", window_policy: "respect_window" },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
    expect(result.stepsAdvanced).toBe(0); // completed, not "advanced"

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("completed");
    expect(membership!.completedAt).not.toBeNull();
    expect(membership!.exitReason).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Crash idempotency
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - crash idempotency", () => {
  it("advances step without duplicate message when message exists but step not advanced", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("crash_idempotent");
    const flowId = await insertFlow({
      name: "Crash test flow",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
        { order: 2, action_type: "follow_up", delay: "1d", window_policy: "respect_window" },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    // Simulate crash state: message for step 1 exists, but current_step still = 1
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "pending_generation",
      brainActionType: "welcome",
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    // Message was NOT created again (conflict hit)
    expect(result.messagesCreated).toBe(0);
    // Step was advanced
    expect(result.stepsAdvanced).toBe(1);

    // Only one message for step 1 (no duplicate)
    const messages = await getMessages(membershipId);
    const step1Messages = messages.filter((m) => m.flowStepOrder === 1);
    expect(step1Messages).toHaveLength(1);

    // Membership advanced to step 2
    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Flow status handling
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - flow status handling", () => {
  it("exits membership when flow is archived (exit_reason: flow_archived)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("archived_flow");
    const flowId = await insertFlow({
      name: "Archived flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "1d", window_policy: "respect_window" },
      ],
      status: "archived",
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsExitedArchived).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("exited");
    expect(membership!.exitReason).toBe("flow_archived");
    expect(membership!.exitedAt).not.toBeNull();
  });

  it("skips membership when flow is paused (no exit, no message)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("paused_flow");
    const flowId = await insertFlow({
      name: "Paused flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" },
      ],
      status: "paused",
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsSkippedPaused).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("active");
    expect(membership!.currentStep).toBe(1);
  });

  it("skips membership when compiled_plan is null (no exit, no message)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("null_plan_flow");
    const flowId = await insertFlow({
      name: "No-plan flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" },
      ],
      status: "active",
      compiledPlan: null,
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsSkippedPaused).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - checkpoint behavior", () => {
  it("deletes checkpoint after a full pass completes", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("checkpoint_complete");
    const flowId = await insertFlow({
      name: "Checkpoint flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" },
      ],
    });

    await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: new Date("2026-07-18T12:00:00Z"),
    });

    const now = new Date("2026-07-20T12:00:00Z");
    await phaseStepAdvancement(db, now, [testTenantId]);

    // Checkpoint should be deleted after full pass
    const checkpoints = await db
      .select()
      .from(scanCheckpoints)
      .where(
        and(
          eq(scanCheckpoints.scanPhase, "step_advancement"),
          eq(scanCheckpoints.tenantId, testTenantId),
        ),
      );
    expect(checkpoints).toHaveLength(0);
  });

  it("discards stale checkpoint and increments discard_count", async () => {
    if (!dbAvailable) return;

    // Insert a stale checkpoint (started 45 minutes ago, threshold is 30)
    const staleStart = new Date("2026-07-20T11:15:00Z");
    await db.insert(scanCheckpoints).values({
      scanPhase: "step_advancement",
      tenantId: testTenantId,
      lastId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      startedAt: staleStart,
      discardCount: 2,
    });

    const contactId = await insertContact("checkpoint_stale");
    const flowId = await insertFlow({
      name: "Stale checkpoint flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" },
      ],
    });

    await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: new Date("2026-07-18T12:00:00Z"),
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.staleCheckpointsDiscarded).toBe(1);
    // The pass should still complete (processes all memberships from start)
    expect(result.messagesCreated).toBe(1);

    // After completion, checkpoint is deleted
    const checkpoints = await db
      .select()
      .from(scanCheckpoints)
      .where(
        and(
          eq(scanCheckpoints.scanPhase, "step_advancement"),
          eq(scanCheckpoints.tenantId, testTenantId),
        ),
      );
    expect(checkpoints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PgGate concurrency tests
// ---------------------------------------------------------------------------

const GATE_LOCK_ID = 799_500; // unique within the test DB

class PgGate {
  private controlClient: pg.Client;
  private url: string;
  private n: number;

  constructor(url: string, n: number) {
    this.url = url;
    this.n = n;
    this.controlClient = new pg.Client({ connectionString: url });
  }

  async lock(): Promise<void> {
    await this.controlClient.connect();
    await this.controlClient.query("SELECT pg_advisory_lock($1)", [GATE_LOCK_ID]);
  }

  async waitForAllBlocked(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await this.controlClient.query(
        `SELECT count(*)::int AS n
         FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND wait_event = 'advisory'
           AND datname = current_database()
           AND pid != pg_backend_pid()`,
      );
      if (result.rows[0].n >= this.n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `PgGate: timed out waiting for ${this.n} callers to block on advisory lock`,
    );
  }

  async release(): Promise<void> {
    await this.controlClient.query("SELECT pg_advisory_unlock($1)", [GATE_LOCK_ID]);
  }

  async close(): Promise<void> {
    await this.controlClient.end();
  }

  callerFn<T>(workFn: () => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      try {
        const result = await workFn();
        return { result, unblockTime };
      } finally {
        await client.query("SELECT pg_advisory_unlock_shared($1)", [GATE_LOCK_ID]);
        await client.end();
      }
    };
  }
}

function assertOverlap(times: Date[], label: string): void {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const spreadMs = sorted[sorted.length - 1]! - sorted[0]!;
  if (spreadMs > 200) {
    throw new Error(
      `[${label}] Overlap not achieved: spread=${spreadMs}ms (threshold=200ms).`,
    );
  }
}

describe("concurrency: two scans advancing the same membership", () => {
  it("CAS ensures exactly one advance (no double-step)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("race_advance");
    const flowId = await insertFlow({
      name: "Race advance flow",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
        { order: 2, action_type: "follow_up", delay: "0m", window_policy: "immediate" },
        { order: 3, action_type: "final", delay: "0m", window_policy: "immediate" },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Both callers will try to advance the same membership
    const callerA = gate.callerFn(async () => phaseStepAdvancement(db, now, [testTenantId]));
    const callerB = gate.callerFn(async () => phaseStepAdvancement(db, now, [testTenantId]));

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "two-scans-advance");

    // Both scans ran, but the CAS ensures idempotent behavior.
    // The unique index prevents duplicate messages. The CAS on current_step
    // prevents double-advancing. After both run, the membership should have
    // advanced exactly as far as a single scan would have advanced it.
    // (Each scan sees current_step=1, creates msg for step 1, advances to 2.
    // One wins; the other hits ON CONFLICT on the message and CAS fails on step.)

    // Check: exactly one message per step was created (no duplicates)
    const allMessages = await db
      .select()
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.flowId, flowId));

    // Each step should have at most one message
    const stepOrders = allMessages.map((m) => m.flowStepOrder);
    const uniqueSteps = new Set(stepOrders);
    expect(uniqueSteps.size).toBe(stepOrders.length);

    await gate.close();
  });
});

describe("concurrency: membership advancing while lifecycle transition fires", () => {
  it("advisory lock on contact serializes enrollment vs advancement without corruption", async () => {
    if (!dbAvailable) return;

    // Scenario: contact is in a nurture flow at step 2. Simultaneously:
    // (A) the scan tries to advance step 2
    // (B) a lifecycle transition fires that would enroll in a higher-priority flow
    //     (which would evict the current membership via priority_override)
    //
    // The advisory lock in enrollment serializes these. Possible outcomes:
    // 1. Advancement runs first: message created for step 2, membership completed,
    //    then enrollment enrolls flow B (no eviction needed - A is already done)
    // 2. Enrollment runs first: evicts membership A, enrolls B, then advancement
    //    sees A is no longer active (CAS fails - no message created)
    //
    // Either way: no data corruption, no inconsistent state.

    const contactId = await insertContact("race_advance_vs_enroll");

    // Flow A: nurture, priority 5, already enrolled at step 2
    const flowAId = await insertFlow({
      name: "Low nurture",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" },
        { order: 2, action_type: "follow_up", delay: "0m", window_policy: "immediate" },
      ],
    });

    // Flow B: nurture, priority 10, lifecycle_transition triggered.
    // Use a DIFFERENT trigger config than flow A so enrollment only picks up flow B.
    const flowBId = await insertFlow({
      name: "High nurture",
      steps: [
        { order: 1, action_type: "urgent", delay: "0m", window_policy: "immediate" },
      ],
    });
    // Override flow B's trigger config to a different transition
    await db
      .update(flows)
      .set({
        priority: 10,
        triggerConfig: { from: "at_risk", to: "dormant" },
      })
      .where(eq(flows.id, flowBId));

    const now = new Date("2026-07-20T12:00:00Z");

    // Enroll contact in flow A at step 2
    const membershipAId = await insertMembership({
      contactId,
      flowId: flowAId,
      currentStep: 2,
      enteredAt: new Date("2026-07-18T12:00:00Z"),
    });

    // Step 1 message for flow A already exists
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId: flowAId,
      membershipId: membershipAId,
      flowStepOrder: 1,
      status: "sent",
      brainActionType: "welcome",
      createdAt: new Date("2026-07-18T12:00:00Z"),
    });

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Caller A: step advancement (advances flow A step 2)
    const callerA = gate.callerFn(async () => phaseStepAdvancement(db, now, [testTenantId]));

    // Caller B: enrollment of flow B via the at_risk->dormant transition
    const { phaseEnrollment } = await import("../src/scan-enrollment.js");
    const callerB = gate.callerFn(async () =>
      phaseEnrollment(
        db,
        [{ tenantId: testTenantId, contactId, fromState: "at_risk", toState: "dormant" }],
        now,
      ),
    );

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "advance-vs-enroll");

    // After both complete, verify consistency:
    const allMemberships = await db
      .select()
      .from(flowMemberships)
      .where(eq(flowMemberships.contactId, contactId));

    const flowAMembership = allMemberships.find((m) => m.flowId === flowAId);
    const flowBMembership = allMemberships.find((m) => m.flowId === flowBId);

    // Flow B should be enrolled (the transition matched).
    // It may already be completed (single step with 0m delay, processed in same scan run).
    expect(flowBMembership).toBeDefined();
    expect(["active", "completed"]).toContain(flowBMembership!.status);

    // Flow A should NOT be active (either completed by advancement or evicted)
    expect(flowAMembership).toBeDefined();
    expect(["completed", "exited"]).toContain(flowAMembership!.status);

    // No data corruption: verify no duplicate messages for the same (membership, step)
    const flowAMessages = await getMessages(membershipAId);
    const stepOrders = flowAMessages.map((m) => m.flowStepOrder);
    const uniqueSteps = new Set(stepOrders);
    expect(uniqueSteps.size).toBe(stepOrders.length);

    await gate.close();
  });
});

// ---------------------------------------------------------------------------
// Step-level condition (proceed-if) tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - step-level condition (proceed-if gate)", () => {
  it("skips step when lifecycle_state condition is false", async () => {
    if (!dbAvailable) return;

    // Contact is "engaged", step condition requires "at_risk"
    const contactId = await insertContact("cond_skip_state", "engaged");
    const flowId = await insertFlow({
      name: "Condition skip flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state: "at_risk" } },
        { order: 2, action_type: "nurture_reactivate", delay: "0m" },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.stepsSkippedCondition).toBe(1);
    expect(result.messagesCreated).toBe(0);

    // Membership advanced to step 2 (skipped step 1)
    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(2);
    expect(membership!.status).toBe("active");
  });

  it("proceeds with step when lifecycle_state condition is true", async () => {
    if (!dbAvailable) return;

    // Contact is "at_risk", step condition requires "at_risk"
    const contactId = await insertContact("cond_pass_state", "at_risk");
    const flowId = await insertFlow({
      name: "Condition pass flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state: "at_risk" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);

    const messages = await getMessages(membershipId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.brainActionType).toBe("nurture_value");
  });

  it("proceeds when lifecycle_state_not condition is true (contact NOT in that state)", async () => {
    if (!dbAvailable) return;

    // Contact is "at_risk", condition requires NOT "engaged"
    const contactId = await insertContact("cond_not_pass", "at_risk");
    const flowId = await insertFlow({
      name: "State-not pass flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state_not: "engaged" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
  });

  it("skips when lifecycle_state_not condition is false (contact IS in that state)", async () => {
    if (!dbAvailable) return;

    // Contact is "engaged", condition requires NOT "engaged" - should skip
    const contactId = await insertContact("cond_not_skip", "engaged");
    const flowId = await insertFlow({
      name: "State-not skip flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state_not: "engaged" } },
        { order: 2, action_type: "follow_up", delay: "0m" },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.stepsSkippedCondition).toBe(1);
    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(2);
  });

  it("proceeds when event_since_step condition is true (event exists)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_event_pass", "engaged");
    const flowId = await insertFlow({
      name: "Event condition pass",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m" },
        { order: 2, action_type: "nurture_value", delay: "0m", condition: { event_since_step: "feature_activated" } },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 2,
      enteredAt,
    });

    // Step 1 message exists (reference time for step 2)
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "sent",
      brainActionType: "welcome",
      createdAt: new Date("2026-07-18T12:00:00Z"),
    });

    // Event occurred after step 1 message was created
    await insertEvent(contactId, "feature_activated", new Date("2026-07-19T10:00:00Z"));

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
  });

  it("skips when event_since_step condition is false (no event since step)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_event_skip", "engaged");
    const flowId = await insertFlow({
      name: "Event condition skip",
      steps: [
        { order: 1, action_type: "welcome", delay: "0m" },
        { order: 2, action_type: "nurture_value", delay: "0m", condition: { event_since_step: "feature_activated" } },
        { order: 3, action_type: "follow_up", delay: "0m" },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 2,
      enteredAt,
    });

    // Step 1 message
    await db.insert(lifecycleMessages).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "sent",
      brainActionType: "welcome",
      createdAt: new Date("2026-07-18T12:00:00Z"),
    });

    // No feature_activated event exists

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.stepsSkippedCondition).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.currentStep).toBe(3);
  });

  it("completes membership when the skipped step is the last step", async () => {
    if (!dbAvailable) return;

    // Contact is "engaged", last step requires "at_risk" - will skip and complete
    const contactId = await insertContact("cond_skip_complete", "engaged");
    const flowId = await insertFlow({
      name: "Skip-complete flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state: "at_risk" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsCompleted).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("completed");
    expect(membership!.exitReason).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Step-level exit_condition tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - paired alternative steps (dunning)", () => {
  // Steps 1/3/5 are for one audience, 2/4/6 for the other; each pair is the
  // same moment. A skipped step leaves no message, so the next delay must
  // count from the last message actually created, not from entered_at:
  // otherwise the second and third mail of the first audience fall on the
  // same day.
  const steps = [
    { order: 1, action_type: "dunning", delay: "0m", condition: { lifecycle_state: "engaged" } },
    { order: 2, action_type: "dunning", delay: "0m", condition: { lifecycle_state_not: "engaged" } },
    { order: 3, action_type: "dunning", delay: "3d", condition: { lifecycle_state: "engaged" } },
    { order: 4, action_type: "dunning", delay: "0m", condition: { lifecycle_state_not: "engaged" } },
    { order: 5, action_type: "dunning", delay: "3d", condition: { lifecycle_state: "engaged" } },
    { order: 6, action_type: "dunning", delay: "0m", condition: { lifecycle_state_not: "engaged" } },
  ];
  const DAY = 24 * 60 * 60 * 1000;

  async function runDays(membershipId: string, entered: Date, days: number[]) {
    const created: Array<{ step: number; day: number }> = [];
    for (const d of days) {
      const now = new Date(entered.getTime() + d * DAY + 60_000);
      // Several passes per moment so zero-delay and skipped steps settle.
      for (let i = 0; i < 4; i++) {
        await db.update(lifecycleMessages).set({ createdAt: now }).where(and(eq(lifecycleMessages.membershipId, membershipId), sql`created_at > ${now}`));
        await phaseStepAdvancement(db, now, [testTenantId]);
      }
      for (const m of await getMessages(membershipId)) {
        if (!created.some((c) => c.step === m.flowStepOrder)) {
          created.push({ step: m.flowStepOrder!, day: d });
          await db.update(lifecycleMessages).set({ createdAt: now }).where(eq(lifecycleMessages.id, m.id));
        }
      }
    }
    return created.sort((a, b) => a.step - b.step);
  }

  it("first audience: mails on day 0, 3 and 6", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("dunning_pair_a", "engaged");
    const flowId = await insertFlow({ name: "Dunning pairs A", steps });
    const entered = new Date("2026-07-20T00:00:00Z");
    const membershipId = await insertMembership({ contactId, flowId, enteredAt: entered });
    expect(await runDays(membershipId, entered, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([
      { step: 1, day: 0 },
      { step: 3, day: 3 },
      { step: 5, day: 6 },
    ]);
  });

  it("second audience: mails on day 0, 3 and 6", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("dunning_pair_b", "at_risk");
    const flowId = await insertFlow({ name: "Dunning pairs B", steps });
    const entered = new Date("2026-07-20T00:00:00Z");
    const membershipId = await insertMembership({ contactId, flowId, enteredAt: entered });
    expect(await runDays(membershipId, entered, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([
      { step: 2, day: 0 },
      { step: 4, day: 3 },
      { step: 6, day: 6 },
    ]);
  });
});

describe("phaseStepAdvancement - step-level exit_condition", () => {
  it("exits membership when step exit_condition is true", async () => {
    if (!dbAvailable) return;

    // Contact is "engaged", step exit_condition checks lifecycle_state: "engaged"
    const contactId = await insertContact("step_exit_fires", "engaged");
    const flowId = await insertFlow({
      name: "Step exit flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", exit_condition: { lifecycle_state: "engaged" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsExitedCondition).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("exited");
    expect(membership!.exitReason).toBe("condition_met");
    expect(membership!.exitedAt).not.toBeNull();
  });

  it("proceeds normally when step exit_condition is false", async () => {
    if (!dbAvailable) return;

    // Contact is "at_risk", step exit_condition checks lifecycle_state: "engaged" - false
    const contactId = await insertContact("step_exit_false", "at_risk");
    const flowId = await insertFlow({
      name: "Step exit false flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", exit_condition: { lifecycle_state: "engaged" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
    expect(result.membershipsExitedCondition).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Plan-level exit_conditions tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - plan-level exit_conditions", () => {
  it("exits membership when lifecycle_state_change exit condition matches", async () => {
    if (!dbAvailable) return;

    // Contact IS currently "engaged", exit condition: lifecycle_state_change to "engaged"
    const contactId = await insertContact("plan_exit_state", "engaged");
    const flowId = await insertFlow({
      name: "Plan exit state flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { lifecycle_state_change: { to: "engaged" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsExitedCondition).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("exited");
    expect(membership!.exitReason).toBe("condition_met");
  });

  it("does not exit when lifecycle_state_change does not match", async () => {
    if (!dbAvailable) return;

    // Contact is "at_risk", exit requires transition to "engaged" - not met
    const contactId = await insertContact("plan_exit_no_match", "at_risk");
    const flowId = await insertFlow({
      name: "Plan exit no match",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { lifecycle_state_change: { to: "engaged" } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    // Should proceed normally
    expect(result.membershipsExitedCondition).toBe(0);
    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
  });

  it("exits when event exit condition matches", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("plan_exit_event", "at_risk");
    const flowId = await insertFlow({
      name: "Plan exit event",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { event: "user_converted" },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    // Event occurred during membership
    await insertEvent(contactId, "user_converted", new Date("2026-07-19T10:00:00Z"));

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsExitedCondition).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("exited");
    expect(membership!.exitReason).toBe("condition_met");
  });

  it("does not exit on event that occurred before membership entered_at", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("plan_exit_event_before", "at_risk");
    const flowId = await insertFlow({
      name: "Plan exit event before",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { event: "user_converted" },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    // Event occurred BEFORE membership - should not trigger exit
    await insertEvent(contactId, "user_converted", new Date("2026-07-17T10:00:00Z"));

    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    // Should proceed normally (event before membership does not count)
    expect(result.membershipsExitedCondition).toBe(0);
    expect(result.messagesCreated).toBe(1);
    expect(result.membershipsCompleted).toBe(1);
  });

  it("exits only when BOTH event AND state match for combined exit condition", async () => {
    if (!dbAvailable) return;

    // Contact is "engaged" but event did NOT occur - should NOT exit
    const contactId = await insertContact("plan_exit_combined_partial", "engaged");
    const flowId = await insertFlow({
      name: "Plan exit combined",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { event: "user_returned", lifecycle_state_change: { to: "engaged" } },
      ],
    });

    const enteredAt = new Date("2026-07-18T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt,
    });

    // No event, but state matches - combined condition requires both
    const now = new Date("2026-07-20T12:00:00Z");
    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    // Should NOT exit (event is missing)
    expect(result.membershipsExitedCondition).toBe(0);
    expect(result.messagesCreated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Condition error handling tests
// ---------------------------------------------------------------------------

describe("phaseStepAdvancement - condition_error handling", () => {
  it("records condition_error for unrecognized step condition shape", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_error_step", "engaged");
    const flowId = await insertFlow({
      name: "Bad condition flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { user_still_at_risk: true } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsStuckConditionError).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("active");
    expect(membership!.currentStep).toBe(1); // Not advanced
    expect(membership!.conditionError).toContain("step 1 condition");
    expect(membership!.conditionError).toContain("user_still_at_risk");
  });

  it("records condition_error for unrecognized plan-level exit condition", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_error_plan", "at_risk");
    const flowId = await insertFlow({
      name: "Bad exit condition flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m" },
      ],
      exitConditions: [
        { unknown_key: "bad_value" },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const result = await phaseStepAdvancement(db, now, [testTenantId]);

    expect(result.membershipsStuckConditionError).toBe(1);
    expect(result.messagesCreated).toBe(0);

    const membership = await getMembership(membershipId);
    expect(membership!.status).toBe("active");
    expect(membership!.conditionError).toContain("plan-level exit_conditions");
    expect(membership!.conditionError).toContain("unknown_key");
  });

  it("self-clears condition_error when flow is recompiled with valid conditions", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_error_clear", "at_risk");
    const flowId = await insertFlow({
      name: "Recompiled flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { bad_shape: 1 } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    // First pass: condition_error is recorded
    await phaseStepAdvancement(db, now, [testTenantId]);
    let membership = await getMembership(membershipId);
    expect(membership!.conditionError).not.toBeNull();

    // "Recompile" the flow with a valid condition
    await db
      .update(flows)
      .set({
        compiledPlan: {
          trigger: { type: "lifecycle_transition", condition: {} },
          steps: [
            { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state: "at_risk" } },
          ],
        },
      })
      .where(eq(flows.id, flowId));

    // Second pass: condition_error is cleared and step proceeds
    const result2 = await phaseStepAdvancement(db, now, [testTenantId]);
    expect(result2.messagesCreated).toBe(1);
    expect(result2.membershipsStuckConditionError).toBe(0);

    membership = await getMembership(membershipId);
    expect(membership!.conditionError).toBeNull();
    expect(membership!.status).toBe("completed");
  });

  it("does not churn rows when condition_error is the same on repeat passes", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("cond_error_idempotent", "engaged");
    const flowId = await insertFlow({
      name: "Idempotent error flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { bad: true } },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    // First pass
    await phaseStepAdvancement(db, now, [testTenantId]);
    const membership1 = await getMembership(membershipId);
    const error1 = membership1!.conditionError;

    // Second pass - same error, should not generate a new UPDATE
    // (We cannot directly observe no-write, but we can verify the value is unchanged)
    await phaseStepAdvancement(db, now, [testTenantId]);
    const membership2 = await getMembership(membershipId);
    expect(membership2!.conditionError).toBe(error1);
  });
});

// ---------------------------------------------------------------------------
// PgGate concurrency: condition evaluation during lifecycle state change
// ---------------------------------------------------------------------------

describe("concurrency: condition evaluation does not corrupt data when lifecycle_state changes mid-scan", () => {
  it("no constraint violations or double-advances when state changes during condition check", async () => {
    if (!dbAvailable) return;

    // Scenario: contact is at_risk with a condition { lifecycle_state: "at_risk" }.
    // (A) The scan evaluates the condition, sees at_risk, creates message.
    // (B) Simultaneously, a state transition changes the contact to "engaged".
    // Result: no corruption. The message may or may not be created depending on
    // ordering, but no constraint violations and no double-step.

    const contactId = await insertContact("race_condition_state", "at_risk");
    const flowId = await insertFlow({
      name: "Race condition flow",
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { lifecycle_state: "at_risk" } },
        { order: 2, action_type: "follow_up", delay: "0m" },
      ],
    });

    const now = new Date("2026-07-20T12:00:00Z");
    const membershipId = await insertMembership({
      contactId,
      flowId,
      currentStep: 1,
      enteredAt: now,
    });

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Caller A: scan with condition evaluation
    const callerA = gate.callerFn(async () => phaseStepAdvancement(db, now, [testTenantId]));

    // Caller B: lifecycle state change (simulating ingest-driven transition)
    const callerB = gate.callerFn(async () => {
      await updateContactState(contactId, "engaged");
      return { stateChanged: true };
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "condition-vs-state-change");

    // Verify no corruption: membership should be in a valid state
    const membership = await getMembership(membershipId);
    expect(membership).not.toBeNull();
    expect(["active", "completed"]).toContain(membership!.status);

    // Verify no duplicate messages
    const messages = await getMessages(membershipId);
    const stepOrders2 = messages.map((m) => m.flowStepOrder);
    const uniqueSteps2 = new Set(stepOrders2);
    expect(uniqueSteps2.size).toBe(stepOrders2.length);

    await gate.close();
  });
});
