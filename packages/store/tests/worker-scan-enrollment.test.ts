/**
 * Contract tests for workerScanEnrollment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertFlow, byId } from "./support/worker-fixtures.js";

for (const factory of testBackends()) {
  describe(`workerScanEnrollment on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("listActiveLifecycleTransitionFlows returns only active, compiled lifecycle_transition flows of the tenant", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const ready = { status: "active", triggerType: "lifecycle_transition", compileStatus: "ready", compiledPlan: { steps: [] } };
      const a = await insertFlow(b, t, {
        ...ready,
        priority: 7,
        triggerConfig: { k: "v" },
        flowClass: "critical",
        reentryPolicy: "once",
        reentryCooldownDays: 12,
      });
      const c = await insertFlow(b, t, { ...ready });
      await insertFlow(b, t, { ...ready, status: "paused" });
      await insertFlow(b, t, { ...ready, triggerType: "manual" });
      await insertFlow(b, t, { ...ready, compileStatus: "failed" });
      await insertFlow(b, t, { ...ready, compiledPlan: null });
      await insertFlow(b, other, { ...ready });

      const rows = byId(await b.store.workerScanEnrollment.listActiveLifecycleTransitionFlows(t));
      expect(rows).toEqual(
        byId([
          {
            id: a,
            tenantId: t,
            priority: 7,
            triggerType: "lifecycle_transition",
            triggerConfig: { k: "v" },
            flowClass: "critical",
            reentryPolicy: "once",
            reentryCooldownDays: 12,
          },
          {
            id: c,
            tenantId: t,
            priority: 0,
            triggerType: "lifecycle_transition",
            triggerConfig: { event: "x" },
            flowClass: "nurture",
            reentryPolicy: "cooldown",
            reentryCooldownDays: 30,
          },
        ]),
      );
    });
  });
}
