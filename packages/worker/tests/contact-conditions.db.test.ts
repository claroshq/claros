/**
 * Contact conditions in the engine (G4, G28): event triggers with `where`
 * (trait, history, first_contact) enroll only matching contacts, and the
 * condition evaluator decides step conditions and plan exits through the
 * lookup context. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tenants, contacts, flows, flowMemberships, lifecycleMessages } from "@claros/db/schema";
import { handleTriggerCheck } from "../src/trigger-check.js";
import { evaluateStepCondition, evaluatePlanExitCondition, type EventChecker } from "../src/condition-evaluator.js";
import { cachedConditionContext } from "@claros/core";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[contact-conditions.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  const [t] = await db.insert(tenants).values({ name: "Conditions", slug: `test-conditions-${randomUUID().slice(0, 8)}` }).returning({ id: tenants.id });
  tenantId = t!.id;
});

afterAll(async () => {
  for (const table of ["lifecycle_messages", "flow_memberships", "events", "lifecycle_transitions"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

async function contact(properties: Record<string, unknown>): Promise<string> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, externalId: `u-${randomUUID().slice(0, 8)}`, email: null, lifecycleState: "signed_up", properties })
    .returning({ id: contacts.id });
  return c!.id;
}

async function eventFlow(event: string, where?: unknown[]): Promise<string> {
  const [f] = await db
    .insert(flows)
    .values({
      tenantId,
      name: `on ${event}`,
      triggerType: "event",
      triggerConfig: where ? { event, where } : { event },
      steps: [],
      status: "active",
      flowClass: "critical",
      reentryPolicy: "every_time",
      compileStatus: "ready",
      compiledPlan: { trigger: { type: "event", condition: { event } }, steps: [{ order: 1, action_type: "x", delay: "0m" }] },
    })
    .returning({ id: flows.id });
  return f!.id;
}

describe("event triggers with where", () => {
  it("enrolls only contacts whose traits and history match", async () => {
    const event = `pricing_viewed_${randomUUID().slice(0, 6)}`;
    const free = await eventFlow(event, [{ trait: { key: "plan_tier", op: "eq", value: "free" } }]);
    const firstOnly = await eventFlow(event, [{ first_contact: true }]);
    const plain = await eventFlow(event);
    const broken = await eventFlow(event, [{ trait: { key: "x", op: "nope" } }]);

    const freeUser = await contact({ plan_tier: "free" });
    const proUser = await contact({ plan_tier: "pro" });
    // proUser was mailed before: not a first contact.
    const [m] = await db.insert(flowMemberships).values({ tenantId, contactId: proUser, flowId: plain, status: "completed", enteredAt: new Date() }).returning({ id: flowMemberships.id });
    await db.insert(lifecycleMessages).values({ tenantId, contactId: proUser, flowId: plain, membershipId: m!.id, flowStepOrder: 9, status: "sent", sentAt: new Date() });

    await handleTriggerCheck({ tenant_id: tenantId, contact_id: freeUser, event_name: event }, db as never);
    await handleTriggerCheck({ tenant_id: tenantId, contact_id: proUser, event_name: event }, db as never);

    const rows = await db.select({ contactId: flowMemberships.contactId, flowId: flowMemberships.flowId }).from(flowMemberships).where(eq(flowMemberships.tenantId, tenantId));
    const enrolled = (c: string) => rows.filter((r) => r.contactId === c).map((r) => r.flowId).sort();
    expect(enrolled(freeUser)).toEqual([free, firstOnly, plain].sort());
    expect(enrolled(proUser)).toEqual([plain, plain].sort());
    expect(rows.some((r) => r.flowId === broken)).toBe(false);
  });
});

describe("condition evaluator with contact conditions", () => {
  const checker = (traits: Record<string, unknown>, sends: number): EventChecker => ({
    hasEventSince: async () => false,
    contact: cachedConditionContext({ now: new Date(), traits: async () => traits, countSends: async () => sends }),
  });

  it("step conditions and plan exits", async () => {
    const since = new Date(0);
    expect(await evaluateStepCondition({ trait: { key: "icp_configured", op: "eq", value: false } }, { lifecycleState: "engaged" }, checker({ icp_configured: false }, 0), since)).toEqual({ outcome: "pass" });
    expect(await evaluateStepCondition({ history: { flow: "welcome", within: "7d", op: "none" } }, { lifecycleState: "engaged" }, checker({}, 1), since)).toEqual({ outcome: "fail" });
    expect(await evaluatePlanExitCondition({ trait: { key: "icp_configured", op: "eq", value: true } }, { lifecycleState: "engaged" }, checker({ icp_configured: true }, 0), since)).toEqual({ outcome: "pass" });
    const noCtx: EventChecker = { hasEventSince: async () => false };
    expect((await evaluateStepCondition({ first_contact: true }, { lifecycleState: "x" }, noCtx, since)).outcome).toBe("unknown_shape");
    expect((await evaluatePlanExitCondition({ trait: { key: "a", op: "bogus" } }, { lifecycleState: "x" }, checker({}, 0), since)).outcome).toBe("unknown_shape");
  });
});
