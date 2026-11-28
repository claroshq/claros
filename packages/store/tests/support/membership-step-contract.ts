/**
 * Contract tests shared by the two areas that advance flow memberships
 * (workerScanStepAdvancement and workerAdvanceMembership): both expose the
 * same flow/contact/event reads and membership CAS writes.
 */
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Backend } from "./backends.js";
import { insertContact, insertEvent, insertFlow, insertMembership, insertMessage } from "./worker-fixtures.js";
import type { WorkerScanStepAdvancementQueries } from "../../src/areas/worker-scan-step-advancement.js";

type Shared = Pick<
  WorkerScanStepAdvancementQueries,
  | "getFlowPlan"
  | "getContactLifecycleState"
  | "hasEventSince"
  | "setConditionError"
  | "exitMembership"
  | "completeMembership"
  | "completeMembershipAtStep"
  | "advanceMembershipStep"
  | "getStepMessageCreatedAt"
  | "createStepMessage"
>;

const now = new Date("2026-11-20T12:00:00Z");

export function membershipStepContract(getB: () => Backend, area: (b: Backend) => Shared): void {
  async function setup() {
    const b = getB();
    const t = await b.newTenant();
    const c = await insertContact(b, t, { lifecycleState: "engaged" });
    const f = await insertFlow(b, t, { compiledPlan: { steps: [{ order: 1 }] }, status: "active" });
    const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f, conditionError: "bad" });
    return { b, t, c, f, m, q: area(b) };
  }

  async function membership(b: Backend, id: string) {
    const [row] = await b.db
      .select()
      .from(b.schema.flowMemberships)
      .where(eq(b.schema.flowMemberships.id, id));
    return row;
  }

  it("getFlowPlan and getContactLifecycleState read the rows or return null", async () => {
    const { b, c, f, q } = await setup();
    expect(await q.getFlowPlan(f)).toEqual({ status: "active", compiledPlan: { steps: [{ order: 1 }] } });
    expect(await q.getFlowPlan(crypto.randomUUID())).toBeNull();
    const draft = await insertFlow(b, (await b.newTenant()), { status: "draft", compiledPlan: null });
    expect(await q.getFlowPlan(draft)).toEqual({ status: "draft", compiledPlan: null });
    expect(await q.getContactLifecycleState(c)).toBe("engaged");
    expect(await q.getContactLifecycleState(crypto.randomUUID())).toBeNull();
  });

  it("hasEventSince matches name and timestamp >= since", async () => {
    const { b, t, c, q } = await setup();
    const ts = new Date("2026-11-10T00:00:00Z");
    await insertEvent(b, { tenantId: t, contactId: c, eventName: "paid", timestamp: ts });
    expect(await q.hasEventSince({ contactId: c, eventName: "paid", since: ts })).toBe(true);
    expect(
      await q.hasEventSince({ contactId: c, eventName: "paid", since: new Date(ts.getTime() + 1) }),
    ).toBe(false);
    expect(await q.hasEventSince({ contactId: c, eventName: "other", since: new Date(0) })).toBe(false);
  });

  it("setConditionError sets and clears", async () => {
    const { b, m, q } = await setup();
    await q.setConditionError({ membershipId: m, conditionError: "x" });
    expect((await membership(b, m)).conditionError).toBe("x");
    await q.setConditionError({ membershipId: m, conditionError: null });
    expect((await membership(b, m)).conditionError).toBeNull();
  });

  it("exitMembership exits active memberships only, optionally clearing condition_error", async () => {
    const { b, m, q } = await setup();
    await q.exitMembership({ membershipId: m, now, exitReason: "condition_met", clearConditionError: false });
    expect(await membership(b, m)).toMatchObject({
      status: "exited",
      exitedAt: now,
      exitReason: "condition_met",
      conditionError: "bad",
    });
    await q.exitMembership({ membershipId: m, now: new Date(0), exitReason: "admin", clearConditionError: true });
    expect(await membership(b, m)).toMatchObject({ exitReason: "condition_met", conditionError: "bad" });

    const s2 = await setup();
    await s2.q.exitMembership({ membershipId: s2.m, now, exitReason: "x", clearConditionError: true });
    expect((await membership(s2.b, s2.m)).conditionError).toBeNull();
  });

  it("completeMembership completes an active membership", async () => {
    const { b, m, q } = await setup();
    await q.completeMembership({ membershipId: m, now, clearConditionError: true });
    expect(await membership(b, m)).toMatchObject({
      status: "completed",
      completedAt: now,
      exitReason: "completed",
      conditionError: null,
      currentStep: 1,
    });
  });

  it("completeMembershipAtStep is a CAS on status and step", async () => {
    const { b, m, q } = await setup();
    expect(await q.completeMembershipAtStep({ membershipId: m, step: 2, now, clearConditionError: false })).toBe(false);
    const results = await Promise.all([
      q.completeMembershipAtStep({ membershipId: m, step: 1, now, clearConditionError: false }),
      q.completeMembershipAtStep({ membershipId: m, step: 1, now, clearConditionError: false }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await membership(b, m)).toMatchObject({
      status: "completed",
      completedAt: now,
      exitReason: "completed",
      currentStep: 1,
      conditionError: "bad",
    });
  });

  it("advanceMembershipStep advances at most once under concurrency", async () => {
    const { b, m, q } = await setup();
    const results = await Promise.all([
      q.advanceMembershipStep({ membershipId: m, fromStep: 1, clearConditionError: true }),
      q.advanceMembershipStep({ membershipId: m, fromStep: 1, clearConditionError: true }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await membership(b, m)).toMatchObject({ currentStep: 2, conditionError: null, status: "active" });
    expect(await q.advanceMembershipStep({ membershipId: m, fromStep: 1, clearConditionError: false })).toBe(false);
  });

  it("createStepMessage is idempotent per (membership, step); getStepMessageCreatedAt reads it", async () => {
    const { b, t, c, f, m, q } = await setup();
    expect(await q.getStepMessageCreatedAt({ membershipId: m, stepOrder: 1 })).toBeNull();
    const input = { tenantId: t, contactId: c, flowId: f, membershipId: m, stepOrder: 1, actionType: "nudge" };
    const ids = await Promise.all([q.createStepMessage(input), q.createStepMessage(input)]);
    expect(ids.filter((x) => x !== null)).toHaveLength(1);
    const id = ids.find((x) => x !== null)!;
    const [row] = await b.db
      .select()
      .from(b.schema.lifecycleMessages)
      .where(eq(b.schema.lifecycleMessages.id, id));
    expect(row).toMatchObject({
      tenantId: t,
      contactId: c,
      flowId: f,
      membershipId: m,
      flowStepOrder: 1,
      status: "pending_generation",
      brainActionType: "nudge",
    });
    expect(await q.getStepMessageCreatedAt({ membershipId: m, stepOrder: 1 })).toEqual(row.createdAt);
    expect(await q.createStepMessage(input)).toBeNull();

    const created = new Date("2026-11-02T00:00:00Z");
    await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: 2, createdAt: created });
    expect(await q.getStepMessageCreatedAt({ membershipId: m, stepOrder: 2 })).toEqual(created);
    // A later step with no message (skipped by its condition) reads the last step that has one.
    expect(await q.getStepMessageCreatedAt({ membershipId: m, stepOrder: 4 })).toEqual(created);
  });

  it("createStepMessage copies the flow's topic onto the message (null without one)", async () => {
    const { b, t, c, f, m, q } = await setup();
    const input = { tenantId: t, contactId: c, flowId: f, membershipId: m, stepOrder: 1, actionType: "nudge" };
    const first = await q.createStepMessage(input);
    const read = async (id: string) =>
      (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];
    expect((await read(first!)).topicId).toBeNull();

    const topicId = randomUUID();
    await b.db.insert(b.schema.topics).values({ id: topicId, tenantId: t, slug: `s-${topicId.slice(0, 8)}`, name: "News", kind: "marketing" });
    await b.db.update(b.schema.flows).set({ topicId }).where(eq(b.schema.flows.id, f));
    const second = await q.createStepMessage({ ...input, stepOrder: 2 });
    expect((await read(second!)).topicId).toBe(topicId);
  });
}
