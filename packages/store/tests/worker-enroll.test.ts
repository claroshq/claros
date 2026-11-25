/**
 * Contract tests for workerEnroll (packages/worker/src/enroll.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { EnrollableFlow } from "@claros/core";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

for (const factory of testBackends()) {
  describe(`workerEnroll on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function flow(
      tenantId: string,
      opts: Partial<Pick<EnrollableFlow, "priority" | "flowClass" | "reentryPolicy" | "reentryCooldownDays">> = {},
    ): Promise<EnrollableFlow> {
      const f = {
        priority: 0,
        flowClass: "nurture" as const,
        reentryPolicy: "cooldown" as const,
        reentryCooldownDays: 30,
        ...opts,
      };
      const id = await insertFlow(b, tenantId, f);
      return { id, tenantId, triggerType: "event", triggerConfig: {}, ...f } as EnrollableFlow;
    }

    async function memberships(contactId: string) {
      return b.db
        .select()
        .from(b.schema.flowMemberships)
        .where(eq(b.schema.flowMemberships.contactId, contactId));
    }

    async function activeNurtureCount(contactId: string): Promise<number> {
      const rows = await b.db
        .select({ id: b.schema.flowMemberships.id })
        .from(b.schema.flowMemberships)
        .innerJoin(b.schema.flows, eq(b.schema.flowMemberships.flowId, b.schema.flows.id))
        .where(
          and(
            eq(b.schema.flowMemberships.contactId, contactId),
            eq(b.schema.flowMemberships.status, "active"),
            eq(b.schema.flows.flowClass, "nurture"),
          ),
        );
      return rows.length;
    }

    it("returns [] for no candidates", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      expect(
        await b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [], now }),
      ).toEqual([]);
    });

    it("enrolls critical flows and only the highest-priority nurture flow, in order", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { email: "a@example.com" });
      const crit = await flow(t, { flowClass: "critical", priority: 0 });
      const low = await flow(t, { priority: 1 });
      const high = await flow(t, { priority: 5 });

      const results = await b.store.workerEnroll.enrollContactInFlows({
        contactId: c,
        tenantId: t,
        candidateFlows: [low, crit, high],
        now,
      });
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ enrolled: true });
      expect(results[1]).toMatchObject({ enrolled: true });
      expect(results[2]).toEqual({ enrolled: false, reason: "nurture_concurrency:higher_priority_enrolled" });

      const rows = await memberships(c);
      expect(rows.map((r: { flowId: string }) => r.flowId).sort()).toEqual([crit.id, high.id].sort());
      const highRow = rows.find((r: { flowId: string }) => r.flowId === high.id);
      expect(highRow.id).toBe((results[1] as { membershipId: string }).membershipId);
      expect(highRow.status).toBe("active");
      expect(highRow.currentStep).toBe(1);
      expect(highRow.tenantId).toBe(t);
      expect(highRow.enteredAt).toEqual(now);
    });

    it("blocks every flow for a suppressed contact", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { email: "s@example.com" });
      await b.db.insert(b.schema.suppressions).values({ tenantId: t, email: "s@example.com", reason: "unsubscribe" });
      const crit = await flow(t, { flowClass: "critical" });
      const nur = await flow(t, { priority: 3 });
      const results = await b.store.workerEnroll.enrollContactInFlows({
        contactId: c,
        tenantId: t,
        candidateFlows: [crit, nur],
        now,
      });
      expect(results).toEqual([
        { enrolled: false, reason: "suppressed" },
        { enrolled: false, reason: "suppressed" },
      ]);
      expect(await memberships(c)).toHaveLength(0);
    });

    it("evicts a lower-priority active nurture membership", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const old = await flow(t, { priority: 1 });
      const oldId = await insertMembership(b, { tenantId: t, contactId: c, flowId: old.id });
      const next = await flow(t, { priority: 5 });

      const results = await b.store.workerEnroll.enrollContactInFlows({
        contactId: c,
        tenantId: t,
        candidateFlows: [next],
        now,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ enrolled: true, evictedMembershipId: oldId });

      const rows = await memberships(c);
      const evicted = rows.find((r: { id: string }) => r.id === oldId);
      expect(evicted.status).toBe("exited");
      expect(evicted.exitReason).toBe("priority_override");
      expect(evicted.exitedAt).toEqual(now);
      expect(await activeNurtureCount(c)).toBe(1);
    });

    it("blocks all nurture candidates behind an equal-or-higher-priority active membership", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const running = await flow(t, { priority: 5 });
      await insertMembership(b, { tenantId: t, contactId: c, flowId: running.id });
      const a = await flow(t, { priority: 5 });
      const bb = await flow(t, { priority: 2 });
      const results = await b.store.workerEnroll.enrollContactInFlows({
        contactId: c,
        tenantId: t,
        candidateFlows: [bb, a],
        now,
      });
      const reason = "nurture_concurrency:existing_priority_5_>=_new_5";
      expect(results).toEqual([
        { enrolled: false, reason },
        { enrolled: false, reason },
      ]);
      expect(await activeNurtureCount(c)).toBe(1);
    });

    it("applies the re-entry policy and falls through to the next nurture flow", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const once = await flow(t, { priority: 9, reentryPolicy: "once" });
      await insertMembership(b, {
        tenantId: t,
        contactId: c,
        flowId: once.id,
        status: "completed",
        completedAt: new Date(now.getTime() - 400 * DAY),
        exitReason: "completed",
      });
      const cool = await flow(t, { priority: 4, reentryPolicy: "cooldown", reentryCooldownDays: 30 });
      await insertMembership(b, {
        tenantId: t,
        contactId: c,
        flowId: cool.id,
        status: "exited",
        exitedAt: new Date(now.getTime() - 40 * DAY),
        exitReason: "condition_met",
      });
      const results = await b.store.workerEnroll.enrollContactInFlows({
        contactId: c,
        tenantId: t,
        candidateFlows: [once, cool],
        now,
      });
      expect(results[0]).toEqual({ enrolled: false, reason: "reentry_blocked" });
      expect(results[1]).toMatchObject({ enrolled: true });
      expect(await activeNurtureCount(c)).toBe(1);
    });

    it("never creates two active nurture memberships under concurrent enrollment", async () => {
      const t = await b.newTenant();
      // Descending and equal priorities: the guard, not eviction order, must hold.
      const sets = [
        await Promise.all([4, 3, 2, 1].map((p) => flow(t, { priority: p }))),
        await Promise.all([3, 3, 3, 3].map((p) => flow(t, { priority: p }))),
        await Promise.all([1, 2, 3, 4].map((p) => flow(t, { priority: p }))),
      ];
      for (const flowsList of sets) {
        const c = await insertContact(b, t);
        const results = await Promise.all(
          flowsList.map((f) =>
            b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [f], now }),
          ),
        );
        expect(results.flat().some((r) => r.enrolled)).toBe(true);
        expect(await activeNurtureCount(c)).toBe(1);
      }
    });

    it("enrolls a contact into the same flow at most once under concurrency", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const crit = await flow(t, { flowClass: "critical", reentryPolicy: "every_time" });
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [crit], now }),
        ),
      );
      const enrolled = results.flat().filter((r) => r.enrolled);
      expect(enrolled).toHaveLength(1);
      for (const r of results.flat().filter((r) => !r.enrolled)) {
        expect(r).toEqual({ enrolled: false, reason: "concurrent_enrollment" });
      }
      expect(await memberships(c)).toHaveLength(1);
    });
  });
}
