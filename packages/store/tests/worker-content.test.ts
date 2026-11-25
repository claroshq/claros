/**
 * Contract tests for the workerContent store area (packages/worker/src/content.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedContact, seedFlow, seedMessage, sorted } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const at = (iso: string) => new Date(iso);
const BODY = { subject: "Hi", bodyHtml: "<p>Hi</p>", bodyText: "Hi" };

for (const factory of testBackends()) {
  describe(`workerContent on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    describe("claimContentBatch", () => {
      it("claims the oldest pending_generation messages of the given tenants and marks them generating", async () => {
        const t = await b.newTenant();
        const other = await b.newTenant();
        const flowId = await seedFlow(b, t);
        const contactId = await seedContact(b, t);
        const m3 = await seedMessage(b, { tenantId: t, flowId, contactId, status: "pending_generation", createdAt: at("2026-01-03T00:00:00Z"), brainActionType: "nudge" });
        const m1 = await seedMessage(b, { tenantId: t, flowId, contactId, status: "pending_generation", createdAt: at("2026-01-01T00:00:00Z") });
        const m2 = await seedMessage(b, { tenantId: t, flowId, contactId, status: "pending_generation", createdAt: at("2026-01-02T00:00:00Z") });
        await seedMessage(b, { tenantId: t, status: "approved", createdAt: at("2025-01-01T00:00:00Z") });
        const otherMsg = await seedMessage(b, { tenantId: other, status: "pending_generation", createdAt: at("2025-01-01T00:00:00Z") });

        const claimed = await b.store.workerContent.claimContentBatch({ now: NOW, limit: 2, tenantIds: [t] });
        expect(sorted(claimed.map((c) => c.id))).toEqual(sorted([m1, m2]));
        const first = claimed.find((c) => c.id === m1)!;
        expect(first).toEqual({
          id: m1,
          tenantId: t,
          contactId,
          flowId,
          membershipId: expect.any(String),
          flowStepOrder: expect.any(Number),
          brainActionType: null,
          forcedActionType: null,
        });
        expect((await getMessage(b, m1)).status).toBe("generating");
        expect((await getMessage(b, m1)).updatedAt).toEqual(NOW);
        expect((await getMessage(b, m3)).status).toBe("pending_generation");
        expect((await getMessage(b, otherMsg)).status).toBe("pending_generation");

        const rest = await b.store.workerContent.claimContentBatch({ now: NOW, limit: 10, tenantIds: [t] });
        expect(rest.map((c) => c.id)).toEqual([m3]);
        expect(rest[0]!.brainActionType).toBe("nudge");
        expect(await b.store.workerContent.claimContentBatch({ now: NOW, limit: 10, tenantIds: [t] })).toEqual([]);
      });

      it("gives each row to exactly one of several concurrent callers", async () => {
        const t = await b.newTenant();
        const flowId = await seedFlow(b, t);
        const contactId = await seedContact(b, t);
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) {
          ids.push(await seedMessage(b, { tenantId: t, flowId, contactId, status: "pending_generation", createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
        }
        const batches = await Promise.all(
          [0, 1, 2].map(() => b.store.workerContent.claimContentBatch({ now: NOW, limit: 3, tenantIds: [t] })),
        );
        const after = await b.store.workerContent.claimContentBatch({ now: NOW, limit: 10, tenantIds: [t] });
        const all = [...batches.flat(), ...after].map((c) => c.id);
        for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(3);
        expect(new Set(all).size).toBe(all.length);
        expect(sorted(all)).toEqual(sorted(ids));
      });
    });

    it("listTenantsWithPendingGeneration lists tenants with pending_generation messages only", async () => {
      const withPending = await b.newTenant();
      const withoutPending = await b.newTenant();
      await seedMessage(b, { tenantId: withPending, status: "pending_generation" });
      await seedMessage(b, { tenantId: withPending, status: "pending_generation" });
      await seedMessage(b, { tenantId: withoutPending, status: "generating" });
      const tenants = await b.store.workerContent.listTenantsWithPendingGeneration();
      expect(tenants.filter((x) => x === withPending)).toHaveLength(1);
      expect(tenants).not.toContain(withoutPending);
    });

    it("markFailed is a CAS from the given status", async () => {
      const t = await b.newTenant();
      const gen = await seedMessage(b, { tenantId: t, status: "generating" });
      const awaiting = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      expect(await b.store.workerContent.markFailed(gen, "awaiting_content", "x", NOW)).toBe(false);
      expect(await b.store.workerContent.markFailed(gen, "generating", "llm error", NOW)).toBe(true);
      expect(await b.store.workerContent.markFailed(gen, "generating", "again", NOW)).toBe(false);
      expect(await b.store.workerContent.markFailed(awaiting, "awaiting_content", "gate", NOW)).toBe(true);
      const row = await getMessage(b, gen);
      expect(row.status).toBe("failed");
      expect(row.brainReasoning).toBe("llm error");
      expect(row.updatedAt).toEqual(NOW);
      expect((await getMessage(b, awaiting)).status).toBe("failed");
    });

    it("markSkipped is a CAS generating -> skipped", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "generating" });
      const other = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      expect(await b.store.workerContent.markSkipped(id, "not relevant", NOW)).toBe(true);
      expect(await b.store.workerContent.markSkipped(id, "again", NOW)).toBe(false);
      expect(await b.store.workerContent.markSkipped(other, "x", NOW)).toBe(false);
      const row = await getMessage(b, id);
      expect(row.status).toBe("skipped");
      expect(row.brainReasoning).toBe("not relevant");
    });

    it("markAwaitingContent is a CAS generating -> awaiting_content (reasoning may be null)", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "generating", brainReasoning: "old" });
      expect(await b.store.workerContent.markAwaitingContent(id, null, NOW)).toBe(true);
      expect(await b.store.workerContent.markAwaitingContent(id, "again", NOW)).toBe(false);
      const row = await getMessage(b, id);
      expect(row.status).toBe("awaiting_content");
      expect(row.brainReasoning).toBeNull();
    });

    it("markValueGated is a CAS awaiting_content -> value_gated storing the draft", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      const gen = await seedMessage(b, { tenantId: t, status: "generating" });
      expect(await b.store.workerContent.markValueGated(gen, BODY, "low value", NOW)).toBe(false);
      expect(await b.store.workerContent.markValueGated(id, BODY, "low value", NOW)).toBe(true);
      expect(await b.store.workerContent.markValueGated(id, BODY, "again", NOW)).toBe(false);
      const row = await getMessage(b, id);
      expect(row).toMatchObject({ status: "value_gated", subject: "Hi", bodyHtml: "<p>Hi</p>", bodyText: "Hi", brainReasoning: "low value" });
    });

    it("completeDraft is a CAS awaiting_content -> target status with content and approved_at", async () => {
      const t = await b.newTenant();
      const a = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      const p = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      const approvedAt = at("2026-03-01T11:00:00Z");
      expect(await b.store.workerContent.completeDraft(a, "approved", BODY, approvedAt, NOW)).toBe(true);
      expect(await b.store.workerContent.completeDraft(a, "approved", BODY, approvedAt, NOW)).toBe(false);
      expect(await b.store.workerContent.completeDraft(p, "pending_approval", BODY, null, NOW)).toBe(true);
      expect(await getMessage(b, a)).toMatchObject({ status: "approved", subject: "Hi", bodyHtml: "<p>Hi</p>", bodyText: "Hi", approvedAt, updatedAt: NOW });
      expect(await getMessage(b, p)).toMatchObject({ status: "pending_approval", approvedAt: null });
    });

    it("completeTemplate is a CAS generating -> target status with content, approved_at and reasoning", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "generating" });
      const wrong = await seedMessage(b, { tenantId: t, status: "awaiting_content" });
      const approvedAt = at("2026-03-01T11:30:00Z");
      expect(await b.store.workerContent.completeTemplate(wrong, "approved", BODY, approvedAt, "tpl", NOW)).toBe(false);
      expect(await b.store.workerContent.completeTemplate(id, "approved", BODY, approvedAt, "tpl", NOW)).toBe(true);
      expect(await b.store.workerContent.completeTemplate(id, "approved", BODY, approvedAt, "tpl", NOW)).toBe(false);
      expect(await getMessage(b, id)).toMatchObject({ status: "approved", subject: "Hi", approvedAt, brainReasoning: "tpl" });
    });

    it("concurrent CAS transitions: exactly one wins", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "generating" });
      const results = await Promise.all([
        b.store.workerContent.markSkipped(id, "a", NOW),
        b.store.workerContent.markAwaitingContent(id, "b", NOW),
        b.store.workerContent.markFailed(id, "generating", "c", NOW),
        b.store.workerContent.completeTemplate(id, "approved", BODY, NOW, "d", NOW),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("getFlowApprovalMode returns the mode, null when unset or missing", async () => {
      const t = await b.newTenant();
      const auto = await seedFlow(b, t, { approvalMode: "auto" });
      const unset = await seedFlow(b, t, { approvalMode: null });
      expect(await b.store.workerContent.getFlowApprovalMode(auto)).toBe("auto");
      expect(await b.store.workerContent.getFlowApprovalMode(unset)).toBeNull();
      expect(await b.store.workerContent.getFlowApprovalMode("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("getActiveTemplate returns the tenant's active template by slug", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      await b.db.insert(b.schema.templates).values([
        { tenantId: t, name: "Welcome", slug: "welcome", subject: "Welcome {{first_name}}", bodyHtml: "<p>Hi</p>", bodyText: null },
        { tenantId: t, name: "Old", slug: "old", subject: "Old", bodyHtml: "<p>Old</p>", bodyText: "Old", isActive: false },
        { tenantId: other, name: "Other", slug: "other", subject: "S", bodyHtml: "H", bodyText: "T" },
      ]);
      expect(await b.store.workerContent.getActiveTemplate(t, "welcome")).toEqual({ subject: "Welcome {{first_name}}", body_html: "<p>Hi</p>", body_text: null });
      expect(await b.store.workerContent.getActiveTemplate(t, "old")).toBeNull();
      expect(await b.store.workerContent.getActiveTemplate(t, "other")).toBeNull();
    });

    it("getTemplateContact returns contact fields with first/last name from properties", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const props = { first_name: "Ada", last_name: "Lovelace", plan: "pro", nested: { a: 1 } };
      const c = await seedContact(b, t, { email: "ada@example.com", externalId: "u-1", properties: props });
      const noProps = await seedContact(b, t, { email: null, externalId: "u-2", properties: null });
      const numeric = await seedContact(b, t, { externalId: "u-3", properties: { first_name: 42, last_name: true } });
      expect(await b.store.workerContent.getTemplateContact(t, c)).toEqual({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        external_id: "u-1",
        properties: props,
      });
      expect(await b.store.workerContent.getTemplateContact(t, noProps)).toEqual({
        first_name: null,
        last_name: null,
        email: null,
        external_id: "u-2",
        properties: null,
      });
      // Postgres ->> returns non-string scalars as text.
      expect(await b.store.workerContent.getTemplateContact(t, numeric)).toMatchObject({ first_name: "42", last_name: "true" });
      expect(await b.store.workerContent.getTemplateContact(other, c)).toBeNull();
    });

    it("getTenantName and getFlowName return names or null", async () => {
      const t = await b.newTenant("Acme Inc");
      const f = await seedFlow(b, t, { name: "Onboarding" });
      expect(await b.store.workerContent.getTenantName(t)).toBe("Acme Inc");
      expect(await b.store.workerContent.getTenantName("00000000-0000-4000-8000-000000000000")).toBeNull();
      expect(await b.store.workerContent.getFlowName(f)).toBe("Onboarding");
      expect(await b.store.workerContent.getFlowName("00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });
}
