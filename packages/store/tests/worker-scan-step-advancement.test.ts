/**
 * Contract tests for workerScanStepAdvancement.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, sortedIds } from "./support/worker-fixtures.js";
import { membershipStepContract } from "./support/membership-step-contract.js";

const ZERO = "00000000-0000-0000-0000-000000000000";

for (const factory of testBackends()) {
  describe(`workerScanStepAdvancement on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("listTenantIds returns all tenant ids ordered", async () => {
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      const ids = await b.store.workerScanStepAdvancement.listTenantIds();
      expect(ids).toEqual(expect.arrayContaining([t1, t2]));
      expect(ids).toEqual(sortedIds(ids));
    });

    it("checkpoint lifecycle: create, get, save cursor, reset, delete", async () => {
      const q = b.store.workerScanStepAdvancement;
      const t = await b.newTenant();
      const phase = "step_advancement";
      const t0 = new Date("2026-11-20T00:00:00Z");
      expect(await q.getCheckpoint({ phase, tenantId: t })).toBeNull();

      await q.createCheckpoint({ phase, tenantId: t, now: t0 });
      await q.createCheckpoint({ phase, tenantId: t, now: new Date(0) }); // no-op
      expect(await q.getCheckpoint({ phase, tenantId: t })).toEqual({ lastId: ZERO, startedAt: t0, discardCount: 0 });

      const cursor = crypto.randomUUID();
      await q.saveCheckpointCursor({ phase, tenantId: t, lastId: cursor });
      expect(await q.getCheckpoint({ phase, tenantId: t })).toEqual({ lastId: cursor, startedAt: t0, discardCount: 0 });

      const t1 = new Date("2026-11-21T00:00:00Z");
      await q.resetCheckpoint({ phase, tenantId: t, now: t1, discardCount: 3 });
      expect(await q.getCheckpoint({ phase, tenantId: t })).toEqual({ lastId: ZERO, startedAt: t1, discardCount: 3 });
      expect(await q.getCheckpoint({ phase: "other", tenantId: t })).toBeNull();

      await q.deleteCheckpoint({ phase, tenantId: t });
      expect(await q.getCheckpoint({ phase, tenantId: t })).toBeNull();
    });

    it("listActiveMembershipsPage pages active memberships of the tenant by id", async () => {
      const t = await b.newTenant();
      const f = await insertFlow(b, t);
      const enteredAt = new Date("2026-11-05T00:00:00Z");
      const active: string[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await insertContact(b, t);
        active.push(await insertMembership(b, { tenantId: t, contactId: c, flowId: f, currentStep: i + 1, enteredAt }));
      }
      await insertMembership(b, { tenantId: t, contactId: await insertContact(b, t), flowId: f, status: "completed" });
      const expected = sortedIds(active);

      const q = b.store.workerScanStepAdvancement;
      const p1 = await q.listActiveMembershipsPage({ tenantId: t, afterId: null, limit: 2 });
      expect(p1.map((r) => r.id)).toEqual(expected.slice(0, 2));
      const p2 = await q.listActiveMembershipsPage({ tenantId: t, afterId: p1[1]!.id, limit: 2 });
      expect(p2.map((r) => r.id)).toEqual(expected.slice(2));
      const first = [...p1, ...p2].find((r) => r.id === active[0]);
      expect(first).toMatchObject({ flowId: f, currentStep: 1, enteredAt, conditionError: null });
      expect(typeof first!.contactId).toBe("string");
    });

    membershipStepContract(() => b, (x) => x.store.workerScanStepAdvancement);
  });
}
