/**
 * Contract tests for the workerProcessMessage store area (packages/worker/src/process-message.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedMessage } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

for (const factory of testBackends()) {
  describe(`workerProcessMessage on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("claimPendingGenerationMessage claims once (pending_generation -> generating)", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "pending_generation", brainActionType: "welcome" });
      const claimed = await b.store.workerProcessMessage.claimPendingGenerationMessage(t, id, NOW);
      expect(claimed).toEqual({
        id,
        tenant_id: t,
        contact_id: expect.any(String),
        flow_id: expect.any(String),
        membership_id: expect.any(String),
        flow_step_order: expect.any(Number),
        brain_action_type: "welcome",
      });
      expect(await getMessage(b, id)).toMatchObject({ status: "generating", updatedAt: NOW });
      expect(await b.store.workerProcessMessage.claimPendingGenerationMessage(t, id, NOW)).toBeNull();
    });

    it("claimPendingGenerationMessage respects tenant and status", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "pending_generation" });
      const approved = await seedMessage(b, { tenantId: t, status: "approved" });
      expect(await b.store.workerProcessMessage.claimPendingGenerationMessage(other, id, NOW)).toBeNull();
      expect(await b.store.workerProcessMessage.claimPendingGenerationMessage(t, approved, NOW)).toBeNull();
      expect((await getMessage(b, id)).status).toBe("pending_generation");
    });

    it("claimPendingGenerationMessage: exactly one of several concurrent callers gets the row", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "pending_generation" });
      const results = await Promise.all([0, 1, 2, 3].map(() => b.store.workerProcessMessage.claimPendingGenerationMessage(t, id, NOW)));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });
  });
}
