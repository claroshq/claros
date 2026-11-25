/**
 * Contract tests for apiLibrary (packages/api/src/routes/library.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import type { LibraryFlowInput, LibraryTemplateInput } from "../src/areas/api-library.js";

const TEMPLATE: LibraryTemplateInput = {
  name: "Welcome", slug: "welcome", subject: "Welcome!", bodyHtml: "<p>Hi {{first_name}}</p>",
  bodyText: null, variables: ["first_name", "company"], category: "nurture",
};

const FLOW: LibraryFlowInput = {
  name: "Onboarding", description: "Welcome series", triggerType: "lifecycle_transition",
  triggerConfig: { to: "signed_up", nested: { a: null } }, steps: [{ type: "send", template: "welcome" }, { type: "wait", days: 2 }],
  source: "library", approvalMode: "auto", flowClass: "nurture", reentryPolicy: "once",
  reentryCooldownDays: 14, priority: 5, compiledPlan: { version: 1, steps: [true, 1.5, "x"] },
};

for (const factory of testBackends()) {
  describe(`apiLibrary on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const q = () => b.store.apiLibrary;

    it("inserts a template once per tenant slug", async () => {
      const t = await b.newTenant();
      expect(await q().insertTemplateIfAbsent({ tenantId: t, template: TEMPLATE })).toBe(true);
      expect(await q().insertTemplateIfAbsent({ tenantId: t, template: { ...TEMPLATE, subject: "Changed" } })).toBe(false);
      const other = await b.newTenant();
      expect(await q().insertTemplateIfAbsent({ tenantId: other, template: TEMPLATE })).toBe(true);

      const tt = b.schema.templates;
      const rows = await b.db.select().from(tt).where(eq(tt.tenantId, t));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Welcome", slug: "welcome", subject: "Welcome!", bodyHtml: "<p>Hi {{first_name}}</p>",
        bodyText: null, variables: ["first_name", "company"], category: "nurture", isActive: true,
      });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("inserts a template with no variables as an empty list", async () => {
      const t = await b.newTenant();
      expect(await q().insertTemplateIfAbsent({ tenantId: t, template: { ...TEMPLATE, variables: [] } })).toBe(true);
      const tt = b.schema.templates;
      const [row] = await b.db.select().from(tt).where(eq(tt.tenantId, t));
      expect(row.variables).toEqual([]);
    });

    it("creates a compiled draft library flow and finds it by name", async () => {
      const t = await b.newTenant();
      expect(await q().findInstalledLibraryFlow({ tenantId: t, name: "Onboarding" })).toBeNull();
      const compiledAt = new Date("2026-11-20T08:00:00.123Z");
      const id = await q().createLibraryFlow({ tenantId: t, flow: FLOW, compiledAt });
      expect(typeof id).toBe("string");
      expect(await q().findInstalledLibraryFlow({ tenantId: t, name: "Onboarding" })).toBe(id);
      expect(await q().findInstalledLibraryFlow({ tenantId: t, name: "Other" })).toBeNull();
      expect(await q().findInstalledLibraryFlow({ tenantId: await b.newTenant(), name: "Onboarding" })).toBeNull();

      const f = b.schema.flows;
      const [row] = await b.db.select().from(f).where(and(eq(f.tenantId, t), eq(f.id, id)));
      expect(row).toMatchObject({
        name: "Onboarding", description: "Welcome series", triggerType: "lifecycle_transition",
        triggerConfig: FLOW.triggerConfig, steps: FLOW.steps, source: "library", status: "draft",
        approvalMode: "auto", flowClass: "nurture", reentryPolicy: "once", reentryCooldownDays: 14,
        priority: 5, compiledPlan: FLOW.compiledPlan, compileStatus: "ready", compiledAt,
        contentMode: "ai_drafted", promptSource: null, compileError: null,
      });
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it("does not report a non-library flow with the same name as installed", async () => {
      const t = await b.newTenant();
      await q().createLibraryFlow({ tenantId: t, flow: { ...FLOW, source: "manual" }, compiledAt: new Date() });
      expect(await q().findInstalledLibraryFlow({ tenantId: t, name: "Onboarding" })).toBeNull();
    });
  });
}
