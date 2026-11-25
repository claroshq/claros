/**
 * Contract tests for the workerDrainMessage store area (packages/worker/src/drain-message.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedMessage } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

for (const factory of testBackends()) {
  describe(`workerDrainMessage on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("claimApprovedMessage claims a due approved message once (approved -> sending)", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "approved", subject: "S", bodyHtml: "H", bodyText: "T", retryCount: 1 });
      const claimed = await b.store.workerDrainMessage.claimApprovedMessage(t, id, NOW);
      expect(claimed).toEqual({
        id,
        tenant_id: t,
        contact_id: expect.any(String),
        flow_id: expect.any(String),
        flow_step_order: expect.any(Number),
        subject: "S",
        body_html: "H",
        body_text: "T",
        retry_count: 1,
      });
      expect(await getMessage(b, id)).toMatchObject({ status: "sending", updatedAt: NOW });
      expect(await b.store.workerDrainMessage.claimApprovedMessage(t, id, NOW)).toBeNull();
    });

    it("claimApprovedMessage respects scheduled_send_at, tenant and status", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const dueExactly = await seedMessage(b, { tenantId: t, status: "approved", scheduledSendAt: NOW });
      const future = await seedMessage(b, { tenantId: t, status: "approved", scheduledSendAt: new Date(NOW.getTime() + 1) });
      const pending = await seedMessage(b, { tenantId: t, status: "pending_approval" });
      expect(await b.store.workerDrainMessage.claimApprovedMessage(other, dueExactly, NOW)).toBeNull();
      expect(await b.store.workerDrainMessage.claimApprovedMessage(t, future, NOW)).toBeNull();
      expect(await b.store.workerDrainMessage.claimApprovedMessage(t, pending, NOW)).toBeNull();
      expect((await b.store.workerDrainMessage.claimApprovedMessage(t, dueExactly, NOW))?.id).toBe(dueExactly);
      expect((await getMessage(b, future)).status).toBe("approved");
    });

    it("claimApprovedMessage: exactly one of several concurrent callers gets the row", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "approved" });
      const results = await Promise.all([0, 1, 2, 3].map(() => b.store.workerDrainMessage.claimApprovedMessage(t, id, NOW)));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });
  });
}
