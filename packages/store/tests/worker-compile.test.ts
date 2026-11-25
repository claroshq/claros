/**
 * Contract tests for the workerCompile store area (packages/worker/src/compile.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { seedFlow, sorted } from "./support/send-path-fixtures.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

for (const factory of testBackends()) {
  describe(`workerCompile on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const flow = async (id: string) => (await b.db.select().from(b.schema.flows).where(eq(b.schema.flows.id, id)))[0];

    it("getFlow returns the tenant's flow, null for another tenant or a missing id", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const triggerConfig = { event: "signed_up", filters: [{ k: "plan", v: null }] };
      const id = await seedFlow(b, t, { triggerType: "event", triggerConfig, promptSource: "Welcome new users", compileStatus: "pending" });
      expect(await b.store.workerCompile.getFlow(t, id)).toMatchObject({
        id,
        tenantId: t,
        triggerType: "event",
        triggerConfig,
        promptSource: "Welcome new users",
        compileStatus: "pending",
      });
      expect(await b.store.workerCompile.getFlow(other, id)).toBeNull();
      expect(await b.store.workerCompile.getFlow(t, MISSING)).toBeNull();
    });

    it("listActiveTemplateSlugs and listActiveKbTitles return the tenant's active rows", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      await b.db.insert(b.schema.templates).values([
        { tenantId: t, name: "A", slug: "welcome", subject: "s", bodyHtml: "h" },
        { tenantId: t, name: "B", slug: "nudge", subject: "s", bodyHtml: "h", isActive: true },
        { tenantId: t, name: "C", slug: "retired", subject: "s", bodyHtml: "h", isActive: false },
        { tenantId: other, name: "D", slug: "foreign", subject: "s", bodyHtml: "h" },
      ]);
      await b.db.insert(b.schema.kbEntries).values([
        { tenantId: t, title: "Pricing", content: "c" },
        { tenantId: t, title: "Setup", content: "c" },
        { tenantId: t, title: "Hidden", content: "c", isActive: false },
        { tenantId: other, title: "Foreign", content: "c" },
      ]);
      expect(sorted(await b.store.workerCompile.listActiveTemplateSlugs(t))).toEqual(["nudge", "welcome"]);
      expect(sorted(await b.store.workerCompile.listActiveKbTitles(t))).toEqual(["Pricing", "Setup"]);
      const empty = await b.newTenant();
      expect(await b.store.workerCompile.listActiveTemplateSlugs(empty)).toEqual([]);
      expect(await b.store.workerCompile.listActiveKbTitles(empty)).toEqual([]);
    });

    it("markCompileReady is a CAS pending -> ready storing the plan", async () => {
      const t = await b.newTenant();
      const id = await seedFlow(b, t, { compileStatus: "pending", compileError: "previous" });
      const notPending = await seedFlow(b, t, { compileStatus: "ready" });
      const plan = { steps: [{ order: 1, action: "send", template: "welcome" }], exit: null };
      const before = Date.now();
      expect(await b.store.workerCompile.markCompileReady(id, plan)).toBe(true);
      expect(await b.store.workerCompile.markCompileReady(id, plan)).toBe(false);
      expect(await b.store.workerCompile.markCompileReady(notPending, plan)).toBe(false);
      const row = await flow(id);
      expect(row).toMatchObject({ compileStatus: "ready", compiledPlan: plan, compileError: null });
      expect(row.compiledAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect((await flow(notPending)).compiledPlan).toBeNull();
    });

    it("markCompileFailed is a CAS pending -> failed storing the error", async () => {
      const t = await b.newTenant();
      const id = await seedFlow(b, t, { compileStatus: "pending" });
      const nullStatus = await seedFlow(b, t, { compileStatus: null });
      expect(await b.store.workerCompile.markCompileFailed(id, "bad plan")).toBe(true);
      expect(await b.store.workerCompile.markCompileFailed(id, "again")).toBe(false);
      expect(await b.store.workerCompile.markCompileFailed(nullStatus, "x")).toBe(false);
      expect(await flow(id)).toMatchObject({ compileStatus: "failed", compileError: "bad plan", compiledPlan: null });
      expect((await flow(nullStatus)).compileStatus).toBeNull();
    });

    it("concurrent ready/failed: exactly one wins", async () => {
      const t = await b.newTenant();
      const id = await seedFlow(b, t, { compileStatus: "pending" });
      const results = await Promise.all([
        b.store.workerCompile.markCompileReady(id, { steps: [] }),
        b.store.workerCompile.markCompileFailed(id, "x"),
        b.store.workerCompile.markCompileReady(id, { steps: [1] }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}
