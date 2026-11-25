/**
 * Contract tests for the apiFlows store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const baseFlow = (tenantId: string, name = "Welcome") => ({
  tenantId,
  name,
  description: null,
  priority: 5,
  triggerType: "event",
  triggerConfig: { event: "signed_up" },
  steps: [{ order: 1, action: "send" }],
  source: "manual",
  contentMode: "ai_drafted",
  status: "draft",
  approvalMode: "require",
  flowClass: "nurture",
  reentryPolicy: "cooldown",
  reentryCooldownDays: 30,
  promptSource: "welcome new users",
  compiledPlan: null,
  compiledAt: null,
});

for (const factory of testBackends()) {
  describe(`apiFlows on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("createFlow returns the full row with defaults and parsed JSON", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      expect(row).toBeDefined();
      expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row!.tenantId).toBe(t);
      expect(row!.triggerConfig).toEqual({ event: "signed_up" });
      expect(row!.steps).toEqual([{ order: 1, action: "send" }]);
      expect(row!.compiledPlan).toBeNull();
      expect(row!.compiledAt).toBeNull();
      expect(row!.compileStatus).toBeNull();
      expect(row!.createdAt).toBeInstanceOf(Date);
      expect(row!.updatedAt).toBeInstanceOf(Date);
      expect(row!.priority).toBe(5);
    });

    it("listFlows orders by created_at and hides archived unless asked", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const base = Date.UTC(2026, 0, 1);
      const ids: string[] = [];
      for (const [i, status] of (["active", "archived", "draft"] as const).entries()) {
        const id = randomUUID();
        ids.push(id);
        await b.db.insert(b.schema.flows).values({
          ...baseFlow(t, `f${i}`),
          id,
          status,
          createdAt: new Date(base + (3 - i) * 1000), // inserted newest first
        });
      }
      await b.store.apiFlows.createFlow(baseFlow(other));

      const visible = await b.store.apiFlows.listFlows({ tenantId: t, includeArchived: false });
      expect(visible.map((f) => f.name)).toEqual(["f2", "f0"]);
      const all = await b.store.apiFlows.listFlows({ tenantId: t, includeArchived: true });
      expect(all.map((f) => f.name)).toEqual(["f2", "f1", "f0"]);
    });

    it("findFlow is tenant scoped", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      expect((await b.store.apiFlows.findFlow({ tenantId: t, id: row!.id }))?.name).toBe("Welcome");
      expect(await b.store.apiFlows.findFlow({ tenantId: other, id: row!.id })).toBeNull();
      expect(await b.store.apiFlows.findFlow({ tenantId: t, id: randomUUID() })).toBeNull();
    });

    it("updateFlow applies a patch and clears compile fields", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      await b.store.apiFlows.saveFixedPlan({
        tenantId: t,
        id: row!.id,
        compiledPlan: { steps: [] },
        steps: [],
        compiledAt: new Date(),
        updatedAt: new Date(),
      });
      const now = new Date(Date.UTC(2026, 1, 2, 3, 4, 5, 678));
      const updated = await b.store.apiFlows.updateFlow({
        tenantId: t,
        id: row!.id,
        patch: {
          updatedAt: now,
          name: "Renamed",
          triggerConfig: { event: "x" },
          compiledPlan: null,
          compiledAt: null,
          compileStatus: null,
          compileError: null,
        },
      });
      expect(updated?.name).toBe("Renamed");
      expect(updated?.triggerConfig).toEqual({ event: "x" });
      expect(updated?.compiledPlan).toBeNull();
      expect(updated?.compiledAt).toBeNull();
      expect(updated?.compileStatus).toBeNull();
      expect(updated?.updatedAt?.getTime()).toBe(now.getTime());
      expect(updated?.description).toBeNull();
      expect(
        await b.store.apiFlows.updateFlow({ tenantId: await b.newTenant(), id: row!.id, patch: { updatedAt: now, name: "x" } }),
      ).toBeNull();
    });

    it("updateFlow with expectedStatus is a CAS: concurrent transitions, one wins", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      const results = await Promise.all(
        ["active", "paused"].map((status) =>
          b.store.apiFlows.updateFlow({
            tenantId: t,
            id: row!.id,
            patch: { updatedAt: new Date(), status },
            expectedStatus: "draft",
          }),
        ),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const current = await b.store.apiFlows.findFlow({ tenantId: t, id: row!.id });
      expect(current?.status).toBe(winners[0]!.status);
      // stale expectedStatus fails
      expect(
        await b.store.apiFlows.updateFlow({
          tenantId: t,
          id: row!.id,
          patch: { updatedAt: new Date(), status: "active" },
          expectedStatus: "draft",
        }),
      ).toBeNull();
    });

    it("archiveFlow sets status archived (tenant scoped)", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      const now = new Date(Date.UTC(2026, 2, 3));
      expect(await b.store.apiFlows.archiveFlow({ tenantId: await b.newTenant(), id: row!.id, now })).toBeUndefined();
      const archived = await b.store.apiFlows.archiveFlow({ tenantId: t, id: row!.id, now });
      expect(archived?.status).toBe("archived");
      expect(archived?.updatedAt?.getTime()).toBe(now.getTime());
    });

    it("hasActiveLlmConfig and findActiveLlmConfig see only active configs", async () => {
      const t = await b.newTenant();
      expect(await b.store.apiFlows.hasActiveLlmConfig(t)).toBe(false);
      expect(await b.store.apiFlows.findActiveLlmConfig(t)).toBeNull();
      await b.db.insert(b.schema.llmConfigs).values({ tenantId: t, provider: "openai", config: "old", isActive: false });
      expect(await b.store.apiFlows.hasActiveLlmConfig(t)).toBe(false);
      await b.db.insert(b.schema.llmConfigs).values({ tenantId: t, provider: "openai", config: "envelope", isActive: true });
      expect(await b.store.apiFlows.hasActiveLlmConfig(t)).toBe(true);
      expect(await b.store.apiFlows.findActiveLlmConfig(t)).toEqual({ config: "envelope" });
    });

    it("markCompilePending sets pending and clears the error", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      await b.db
        .update(b.schema.flows)
        .set({ compileStatus: "failed", compileError: "boom" })
        .where(eq(b.schema.flows.id, row!.id));
      const now = new Date(Date.UTC(2026, 3, 4));
      await b.store.apiFlows.markCompilePending({ tenantId: t, id: row!.id, now });
      const after = await b.store.apiFlows.findFlow({ tenantId: t, id: row!.id });
      expect(after?.compileStatus).toBe("pending");
      expect(after?.compileError).toBeNull();
      expect(after?.updatedAt?.getTime()).toBe(now.getTime());
    });

    it("upsertStepTemplate inserts then updates by (tenant, slug)", async () => {
      const t = await b.newTenant();
      const args = {
        tenantId: t,
        name: "Step 1",
        slug: "flow-step-1",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        bodyText: null,
        variables: ["name"],
      };
      await b.store.apiFlows.upsertStepTemplate(args);
      await b.db.update(b.schema.templates).set({ isActive: false }).where(eq(b.schema.templates.tenantId, t));
      await b.store.apiFlows.upsertStepTemplate({ ...args, subject: "Hello", bodyText: "Hello", variables: ["a", "b"] });
      const rows = await b.db
        .select()
        .from(b.schema.templates)
        .where(and(eq(b.schema.templates.tenantId, t), eq(b.schema.templates.slug, "flow-step-1")));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Step 1",
        subject: "Hello",
        bodyText: "Hello",
        variables: ["a", "b"],
        category: "flow",
        isActive: true,
      });
    });

    it("saveFixedPlan stores the plan and marks it ready", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiFlows.createFlow(baseFlow(t));
      const compiledAt = new Date(Date.UTC(2026, 4, 5, 6, 7, 8, 9));
      const saved = await b.store.apiFlows.saveFixedPlan({
        tenantId: t,
        id: row!.id,
        compiledPlan: { version: 1, steps: [{ order: 1 }] },
        steps: [{ order: 1, action: "send", templateSlug: "x" }],
        compiledAt,
        updatedAt: compiledAt,
      });
      expect(saved?.compileStatus).toBe("ready");
      expect(saved?.compileError).toBeNull();
      expect(saved?.compiledPlan).toEqual({ version: 1, steps: [{ order: 1 }] });
      expect(saved?.steps).toEqual([{ order: 1, action: "send", templateSlug: "x" }]);
      expect(saved?.compiledAt?.getTime()).toBe(compiledAt.getTime());
      expect(
        await b.store.apiFlows.saveFixedPlan({
          tenantId: await b.newTenant(),
          id: row!.id,
          compiledPlan: {},
          steps: [],
          compiledAt,
          updatedAt: compiledAt,
        }),
      ).toBeUndefined();
    });

    it("findTenantName", async () => {
      const t = await b.newTenant("Acme Inc");
      expect(await b.store.apiFlows.findTenantName(t)).toBe("Acme Inc");
      expect(await b.store.apiFlows.findTenantName(randomUUID())).toBeNull();
    });
  });
}
