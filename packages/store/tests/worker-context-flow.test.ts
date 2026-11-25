/**
 * Contract tests for workerContextFlow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertFlow } from "./support/worker-fixtures.js";

for (const factory of testBackends()) {
  describe(`workerContextFlow on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getCompiledPlan returns the plan, null plan, or not found", async () => {
      const t = await b.newTenant();
      const plan = { steps: [{ order: 1, action: "email" }], exit: null };
      const f = await insertFlow(b, t, { compiledPlan: plan });
      const bare = await insertFlow(b, t);
      const q = b.store.workerContextFlow;
      expect(await q.getCompiledPlan({ tenantId: t, flowId: f })).toEqual({ found: true, compiledPlan: plan });
      expect(await q.getCompiledPlan({ tenantId: t, flowId: bare })).toEqual({ found: true, compiledPlan: null });
      expect(await q.getCompiledPlan({ tenantId: await b.newTenant(), flowId: f })).toEqual({ found: false });
    });

    it("getActiveSenderName reads an active transport config", async () => {
      const t = await b.newTenant();
      const q = b.store.workerContextFlow;
      const base = { tenantId: t, provider: "resend", config: {}, fromEmail: "x@example.com" };
      await b.db.insert(b.schema.transportConfigs).values({ ...base, isActive: false, fromName: "Old" });
      expect(await q.getActiveSenderName(t)).toEqual({ found: false });
      await b.db.insert(b.schema.transportConfigs).values({ ...base, isActive: true, fromName: "Claros" });
      expect(await q.getActiveSenderName(t)).toEqual({ found: true, fromName: "Claros" });

      const t2 = await b.newTenant();
      await b.db.insert(b.schema.transportConfigs).values({ ...base, tenantId: t2, fromName: null });
      expect(await q.getActiveSenderName(t2)).toEqual({ found: true, fromName: null });
    });

    it("getTenantNameAndSettings returns name and parsed settings", async () => {
      const t = await b.newTenant("Acme");
      const q = b.store.workerContextFlow;
      expect(await q.getTenantNameAndSettings(t)).toEqual({ name: "Acme", settings: null });
      await b.db.update(b.schema.tenants).set({ settings: { brand: { voice: "dry" } } }).where(eq(b.schema.tenants.id, t));
      expect(await q.getTenantNameAndSettings(t)).toEqual({ name: "Acme", settings: { brand: { voice: "dry" } } });
      expect(await q.getTenantNameAndSettings(crypto.randomUUID())).toBeNull();
    });
  });
}
