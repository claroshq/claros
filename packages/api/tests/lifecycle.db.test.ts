/**
 * Lifecycle state machine integration tests (task 9).
 *
 * Tests:
 * - Event-driven transitions: signed_up->activated, activated->engaged,
 *   at_risk->engaged, dormant->engaged, churned->resurrected
 * - Activation check with single and multiple activation_events
 * - activated_at is set once and never cleared
 * - Short-circuits: no query when not signed_up, no activation_events, event not in list
 * - Identify events trigger recovery transitions (at_risk/dormant/churned)
 * - lifecycle_transitions audit log is written correctly
 * - Concurrency (PgGate): two simultaneous track events for same at_risk contact
 *   result in exactly one transition row (CAS idempotency)
 * - engagement_depth is not modified
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { buildApp, hashApiKey } from "../src/index.js";
import {
  tenants,
  apiKeys,
  contacts,
  events,
  lifecycleTransitions,
} from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[lifecycle.test] DATABASE_URL is not set.\n\n` +
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
let rawApiKey: string;

const SLUG = "test-lifecycle";

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
        `[lifecycle.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\n` +
          `Cause: ${(err as Error).message}`,
      );
    }
    console.warn(
      "[lifecycle.test] DATABASE_URL not reachable - integration tests will be skipped.",
    );
    return;
  }

  // Clean up test data from previous runs
  await db.execute(
    sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);

  // Create test tenant with activation_events configured
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Test Lifecycle",
      slug: SLUG,
      plan: "free",
      settings: {
        lifecycle: {
          activation_events: ["project_created", "invite_sent"],
        },
      },
    })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  // Create test API key
  rawApiKey = `cl_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(rawApiKey);
  const prefix = rawApiKey.slice(0, 8);
  await db
    .insert(apiKeys)
    .values({ tenantId: testTenantId, keyHash, prefix, label: "lifecycle test key" });
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${testTenantId}`);
  await pool.end();
});

// --- Helpers ---

async function track(
  app: Awaited<ReturnType<typeof buildApp>>,
  userId: string,
  event: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/track",
    headers: { authorization: `Bearer ${rawApiKey}` },
    payload: { userId, event },
  });
}

async function identify(
  app: Awaited<ReturnType<typeof buildApp>>,
  userId: string,
  traits?: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/identify",
    headers: { authorization: `Bearer ${rawApiKey}` },
    payload: { userId, traits },
  });
}

async function getContact(externalId: string) {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, testTenantId), eq(contacts.externalId, externalId)),
    );
  return contact;
}

async function getTransitions(contactId: string) {
  return db
    .select()
    .from(lifecycleTransitions)
    .where(
      and(
        eq(lifecycleTransitions.tenantId, testTenantId),
        eq(lifecycleTransitions.contactId, contactId),
      ),
    );
}

/**
 * Force a contact into a specific lifecycle_state for testing.
 * Bypasses the state machine (test helper only).
 */
async function forceState(externalId: string, state: string) {
  await db
    .update(contacts)
    .set({ lifecycleState: state })
    .where(
      and(eq(contacts.tenantId, testTenantId), eq(contacts.externalId, externalId)),
    );
}

// --- Tests ---

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[lifecycle.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("activation transition (signed_up -> activated)", () => {
  it("does not activate when only one of two required events is sent", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_act_partial", "project_created");

    const contact = await getContact("user_act_partial");
    expect(contact!.lifecycleState).toBe("signed_up");
    expect(contact!.activatedAt).toBeNull();

    // No transition row should exist
    const transitions = await getTransitions(contact!.id);
    expect(transitions).toHaveLength(0);

    await app.close();
  });

  it("activates when all required events are satisfied", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Send first activation event
    await track(app, "user_act_full", "project_created");
    let contact = await getContact("user_act_full");
    expect(contact!.lifecycleState).toBe("signed_up");

    // Send second activation event - should trigger activation
    await track(app, "user_act_full", "invite_sent");
    contact = await getContact("user_act_full");
    expect(contact!.lifecycleState).toBe("activated");
    expect(contact!.activatedAt).not.toBeNull();

    // Audit log should have exactly one transition
    const transitions = await getTransitions(contact!.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("signed_up");
    expect(transitions[0]!.toState).toBe("activated");
    expect(transitions[0]!.triggerEventId).not.toBeNull();

    await app.close();
  });

  it("does not activate when event is not in activation_events list", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_act_irrelevant", "page_viewed");
    const contact = await getContact("user_act_irrelevant");
    expect(contact!.lifecycleState).toBe("signed_up");

    await app.close();
  });

  it("activated_at is set once and not overwritten by subsequent events", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create and activate a contact
    await track(app, "user_act_once", "project_created");
    await track(app, "user_act_once", "invite_sent");
    const contact = await getContact("user_act_once");
    const originalActivatedAt = contact!.activatedAt;
    expect(originalActivatedAt).not.toBeNull();

    // Force back to signed_up (simulating a hypothetical bug scenario)
    // and re-activate - activated_at should NOT change due to COALESCE
    await forceState("user_act_once", "signed_up");
    await track(app, "user_act_once", "project_created");
    await track(app, "user_act_once", "invite_sent");
    const contactAfter = await getContact("user_act_once");
    expect(contactAfter!.activatedAt!.getTime()).toBe(originalActivatedAt!.getTime());

    await app.close();
  });
});

describe("activated -> engaged transition", () => {
  it("any track event moves activated to engaged", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create and activate
    await track(app, "user_act_to_eng", "project_created");
    await track(app, "user_act_to_eng", "invite_sent");
    let contact = await getContact("user_act_to_eng");
    expect(contact!.lifecycleState).toBe("activated");

    // Next activity should move to engaged
    await track(app, "user_act_to_eng", "page_viewed");
    contact = await getContact("user_act_to_eng");
    expect(contact!.lifecycleState).toBe("engaged");

    // Two transitions: signed_up->activated, activated->engaged
    const transitions = await getTransitions(contact!.id);
    expect(transitions).toHaveLength(2);

    await app.close();
  });
});

describe("recovery transitions (at_risk/dormant/churned)", () => {
  it("at_risk -> engaged on any track event", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_at_risk_1", "setup");
    await forceState("user_at_risk_1", "at_risk");

    await track(app, "user_at_risk_1", "login");
    const contact = await getContact("user_at_risk_1");
    expect(contact!.lifecycleState).toBe("engaged");

    const transitions = await getTransitions(contact!.id);
    const recovery = transitions.find(
      (t) => t.fromState === "at_risk" && t.toState === "engaged",
    );
    expect(recovery).toBeDefined();

    await app.close();
  });

  it("dormant -> engaged on any track event", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_dormant_1", "setup");
    await forceState("user_dormant_1", "dormant");

    await track(app, "user_dormant_1", "login");
    const contact = await getContact("user_dormant_1");
    expect(contact!.lifecycleState).toBe("engaged");

    await app.close();
  });

  it("churned -> resurrected on any track event", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_churned_1", "setup");
    await forceState("user_churned_1", "churned");

    await track(app, "user_churned_1", "page_viewed");
    const contact = await getContact("user_churned_1");
    expect(contact!.lifecycleState).toBe("resurrected");

    const transitions = await getTransitions(contact!.id);
    const resurrection = transitions.find(
      (t) => t.fromState === "churned" && t.toState === "resurrected",
    );
    expect(resurrection).toBeDefined();

    await app.close();
  });

  it("identify event also triggers at_risk -> engaged", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_at_risk_identify", "setup");
    await forceState("user_at_risk_identify", "at_risk");

    await identify(app, "user_at_risk_identify", { name: "Updated" });
    const contact = await getContact("user_at_risk_identify");
    expect(contact!.lifecycleState).toBe("engaged");

    await app.close();
  });

  it("identify event triggers churned -> resurrected", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_churned_identify", "setup");
    await forceState("user_churned_identify", "churned");

    await identify(app, "user_churned_identify", { company: "NewCo" });
    const contact = await getContact("user_churned_identify");
    expect(contact!.lifecycleState).toBe("resurrected");

    await app.close();
  });
});

describe("no-op transitions", () => {
  it("engaged contacts do not transition on track events", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_engaged_noop", "setup");
    await forceState("user_engaged_noop", "engaged");

    await track(app, "user_engaged_noop", "another_event");
    const contact = await getContact("user_engaged_noop");
    expect(contact!.lifecycleState).toBe("engaged");

    await app.close();
  });

  it("resurrected contacts do not transition on track events", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_resurrected_noop", "setup");
    await forceState("user_resurrected_noop", "resurrected");

    await track(app, "user_resurrected_noop", "page_viewed");
    const contact = await getContact("user_resurrected_noop");
    expect(contact!.lifecycleState).toBe("resurrected");

    await app.close();
  });
});

describe("engagement_depth untouched", () => {
  it("transitions do not modify engagement_depth", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await track(app, "user_depth_check", "setup");
    // Set an engagement_depth value manually
    await db
      .update(contacts)
      .set({ engagementDepth: "regular", lifecycleState: "at_risk" })
      .where(
        and(
          eq(contacts.tenantId, testTenantId),
          eq(contacts.externalId, "user_depth_check"),
        ),
      );

    // Trigger at_risk -> engaged
    await track(app, "user_depth_check", "login");
    const contact = await getContact("user_depth_check");
    expect(contact!.lifecycleState).toBe("engaged");
    // engagement_depth should be untouched
    expect(contact!.engagementDepth).toBe("regular");

    await app.close();
  });
});

// --- Concurrency Tests (PgGate pattern) ---

const GATE_LOCK_ID = 799_309; // unique within the test DB

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

  callerFn<T>(workFn: (client: pg.Client) => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      try {
        const result = await workFn(client);
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

describe("concurrency: CAS idempotency on lifecycle transitions", () => {
  it("two simultaneous track events for at_risk contact produce exactly one transition row", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create contact and force to at_risk
    await track(app, "user_cas_race", "setup");
    await forceState("user_cas_race", "at_risk");

    const contact = await getContact("user_cas_race");
    const contactId = contact!.id;

    // Clear any transitions from the setup track
    await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE contact_id = ${contactId}`,
    );

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_cas_race", event: "login_a" },
      });
      return res.statusCode;
    });

    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_cas_race", event: "login_b" },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "CAS transition race",
    );

    // Both requests should succeed (200)
    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // Final state should be engaged
    const finalContact = await getContact("user_cas_race");
    expect(finalContact!.lifecycleState).toBe("engaged");

    // Exactly ONE transition row (CAS prevents double-write)
    const transitions = await getTransitions(contactId);
    const recoveryTransitions = transitions.filter(
      (t) => t.fromState === "at_risk" && t.toState === "engaged",
    );
    expect(recoveryTransitions).toHaveLength(1);

    await gate.close();
    await app.close();
  });

  it("two simultaneous activation events: only one transition written", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create a contact (signed_up state) and send the first activation event
    await track(app, "user_cas_activate", "project_created");
    const contact = await getContact("user_cas_activate");
    expect(contact!.lifecycleState).toBe("signed_up");

    const contactId = contact!.id;

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Both send the second activation event simultaneously
    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_cas_activate", event: "invite_sent" },
      });
      return res.statusCode;
    });

    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_cas_activate", event: "invite_sent" },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "CAS activation race",
    );

    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // One of them won the CAS. The other either read signed_up too and lost
    // (final state activated), or read the state after the winner committed
    // and, as any activity after activation does, moved it on to engaged.
    // Which one happens depends on timing; both are correct.
    const finalContact = await getContact("user_cas_activate");
    expect(["activated", "engaged"]).toContain(finalContact!.lifecycleState);
    expect(finalContact!.activatedAt).not.toBeNull();

    // Exactly one signed_up -> activated transition, never two.
    const transitions = await getTransitions(contactId);
    const activationTransitions = transitions.filter(
      (t) => t.fromState === "signed_up" && t.toState === "activated",
    );
    expect(activationTransitions).toHaveLength(1);
    const engagedTransitions = transitions.filter(
      (t) => t.fromState === "activated" && t.toState === "engaged",
    );
    expect(engagedTransitions).toHaveLength(finalContact!.lifecycleState === "engaged" ? 1 : 0);

    await gate.close();
    await app.close();
  });
});
