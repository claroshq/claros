/**
 * Contract tests for workerAdvanceMembership.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership } from "./support/worker-fixtures.js";
import { membershipStepContract } from "./support/membership-step-contract.js";

for (const factory of testBackends()) {
  describe(`workerAdvanceMembership on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getMembership reads a membership, tenant-scoped", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const enteredAt = new Date("2026-11-03T04:05:06.789Z");
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f, currentStep: 3, enteredAt });
      expect(await b.store.workerAdvanceMembership.getMembership({ tenantId: t, membershipId: m })).toEqual({
        id: m,
        contactId: c,
        flowId: f,
        currentStep: 3,
        enteredAt,
        conditionError: null,
        anchorAt: null,
        status: "active",
      });
      expect(
        await b.store.workerAdvanceMembership.getMembership({ tenantId: await b.newTenant(), membershipId: m }),
      ).toBeNull();
    });

    membershipStepContract(() => b, (x) => x.store.workerAdvanceMembership);
  });
}
