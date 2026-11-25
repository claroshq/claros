/**
 * Contract tests for apiTemplates (packages/api/src/routes/templates.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`apiTemplates on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const q = () => b.store.apiTemplates;

    it("reads and sets the business model and settings", async () => {
      const t = await b.newTenant();
      expect(await q().getTenantTemplateState({ tenantId: t })).toEqual({ businessModel: null, settings: null });
      const settings = { lifecycle: { activation_events: ["x"], dormant_days: 20 }, n: null };
      await q().setBusinessModel({ tenantId: t, businessModel: "freemium", settings });
      expect(await q().getTenantTemplateState({ tenantId: t })).toEqual({ businessModel: "freemium", settings });
      expect(await q().getTenantTemplateState({ tenantId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    });

    it("inserts an uncompiled library draft flow", async () => {
      const t = await b.newTenant();
      const flow = {
        name: "Trial nudge", description: "Nudge trials", triggerType: "event",
        triggerConfig: { event: "trial_started" }, steps: [{ type: "send" }, { type: "wait", days: 1 }],
        flowClass: "critical", reentryPolicy: "every_time", promptSource: "When a trial starts, nudge them",
      };
      const inserted = await q().insertDraftFlow({ tenantId: t, flow });
      expect(inserted).toMatchObject({ name: "Trial nudge", status: "draft" });
      expect(Object.keys(inserted!).sort()).toEqual(["id", "name", "status"]);

      const f = b.schema.flows;
      const [row] = await b.db.select().from(f).where(and(eq(f.tenantId, t), eq(f.id, inserted!.id)));
      expect(row).toMatchObject({
        description: "Nudge trials", priority: 0, triggerType: "event", triggerConfig: flow.triggerConfig,
        steps: flow.steps, source: "library", status: "draft", approvalMode: "require", flowClass: "critical",
        reentryPolicy: "every_time", reentryCooldownDays: 30, promptSource: flow.promptSource,
        compiledPlan: null, compiledAt: null, compileStatus: null, compileError: null,
      });
    });
  });
}
