/**
 * Contract tests for the workerDrain store area (packages/worker/src/drain.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedContact, seedFlow, seedMessage, sorted } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const at = (iso: string) => new Date(iso);
const MISSING = "00000000-0000-4000-8000-000000000000";

for (const factory of testBackends()) {
  describe(`workerDrain on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    describe("claimDrainBatch", () => {
      it("claims due approved messages critical first, then priority DESC (NULL first, as pg), then FIFO", async () => {
        const t = await b.newTenant();
        const other = await b.newTenant();
        const contactId = await seedContact(b, t);
        const critical = await seedFlow(b, t, { flowClass: "critical", priority: 0 });
        const high = await seedFlow(b, t, { priority: 10 });
        const low = await seedFlow(b, t, { priority: 1 });
        const nullPrio = await seedFlow(b, t, { priority: null });
        const msg = (flowId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
          seedMessage(b, { tenantId: t, contactId, flowId, status: "approved", createdAt: at(createdAt), ...extra });

        const lowOld = await msg(low, "2026-01-01T00:00:00Z");
        const highNew = await msg(high, "2026-01-05T00:00:00Z", { subject: "S", bodyHtml: "<p>B</p>", bodyText: "B", retryCount: 2 });
        const highOld = await msg(high, "2026-01-02T00:00:00Z");
        const crit = await msg(critical, "2026-01-09T00:00:00Z");
        const nullP = await msg(nullPrio, "2026-01-03T00:00:00Z");
        const dueNow = await msg(low, "2026-01-06T00:00:00Z", { scheduledSendAt: NOW });
        // Not claimable: future schedule, wrong status, other tenant.
        const future = await msg(critical, "2025-01-01T00:00:00Z", { scheduledSendAt: at("2026-03-01T12:00:00.001Z") });
        const pending = await msg(critical, "2025-01-01T00:00:00Z", { status: "pending_approval" });
        const otherMsg = await seedMessage(b, { tenantId: other, status: "approved" });

        const first = await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 3, tenantIds: [t] });
        expect(first.map((m) => m.id)).toEqual([crit, nullP, highOld]);
        const rest = await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 10, tenantIds: [t] });
        expect(rest.map((m) => m.id)).toEqual([highNew, lowOld, dueNow]);
        expect(rest[0]).toEqual({
          id: highNew,
          tenantId: t,
          contactId,
          flowId: high,
          flowStepOrder: expect.any(Number),
          subject: "S",
          bodyHtml: "<p>B</p>",
          bodyText: "B",
          retryCount: 2,
          topicId: null,
        });
        expect(await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 10, tenantIds: [t] })).toEqual([]);

        const row = await getMessage(b, crit);
        expect(row.status).toBe("sending");
        expect(row.updatedAt).toEqual(NOW);
        for (const id of [future]) expect((await getMessage(b, id)).status).toBe("approved");
        expect((await getMessage(b, pending)).status).toBe("pending_approval");
        expect((await getMessage(b, otherMsg)).status).toBe("approved");
      });

      it("filters by every tenant in the list", async () => {
        const t1 = await b.newTenant();
        const t2 = await b.newTenant();
        const m1 = await seedMessage(b, { tenantId: t1, status: "approved" });
        const m2 = await seedMessage(b, { tenantId: t2, status: "approved" });
        const claimed = await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 10, tenantIds: [t1, t2] });
        expect(sorted(claimed.map((m) => m.id))).toEqual(sorted([m1, m2]));
      });

      it("gives each row to exactly one of several concurrent callers", async () => {
        const t = await b.newTenant();
        const contactId = await seedContact(b, t);
        const flowId = await seedFlow(b, t);
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) {
          ids.push(await seedMessage(b, { tenantId: t, contactId, flowId, status: "approved", createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
        }
        const batches = await Promise.all(
          [0, 1, 2].map(() => b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 3, tenantIds: [t] })),
        );
        const after = await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 10, tenantIds: [t] });
        const all = [...batches.flat(), ...after].map((m) => m.id);
        for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(3);
        expect(new Set(all).size).toBe(all.length);
        expect(sorted(all)).toEqual(sorted(ids));
      });
    });

    it("listTenantsWithDueMessages lists tenants with approved messages due at now", async () => {
      const due = await b.newTenant();
      const later = await b.newTenant();
      const notApproved = await b.newTenant();
      await seedMessage(b, { tenantId: due, status: "approved", scheduledSendAt: NOW });
      await seedMessage(b, { tenantId: due, status: "approved" });
      await seedMessage(b, { tenantId: later, status: "approved", scheduledSendAt: at("2026-03-02T00:00:00Z") });
      await seedMessage(b, { tenantId: notApproved, status: "sending" });
      const tenants = await b.store.workerDrain.listTenantsWithDueMessages(NOW);
      expect(tenants.filter((x) => x === due)).toHaveLength(1);
      expect(tenants).not.toContain(later);
      expect(tenants).not.toContain(notApproved);
    });

    it("getTransportDailyLimit and getSender read the active transport config", async () => {
      const t = await b.newTenant();
      const unset = await b.newTenant();
      const none = await b.newTenant();
      await b.db.insert(b.schema.transportConfigs).values([
        { tenantId: t, provider: "resend", config: { v: 1 }, fromEmail: "old@x.com", isActive: false, dailyLimit: 5 },
        { tenantId: t, provider: "resend", config: { v: 1 }, fromEmail: "hi@x.com", fromName: "Acme", dailyLimit: 500 },
        { tenantId: unset, provider: "smtp", config: { v: 1 }, fromEmail: "a@y.com" },
      ]);
      expect(await b.store.workerDrain.getTransportDailyLimit(t)).toBe(500);
      expect(await b.store.workerDrain.getTransportDailyLimit(unset)).toBeNull();
      expect(await b.store.workerDrain.getTransportDailyLimit(none)).toBeNull();
      expect(await b.store.workerDrain.getSender(t)).toEqual({ fromEmail: "hi@x.com", fromName: "Acme" });
      expect(await b.store.workerDrain.getSender(unset)).toEqual({ fromEmail: "a@y.com", fromName: null });
      expect(await b.store.workerDrain.getSender(none)).toBeNull();
    });

    it("countSentSince counts the tenant's sent messages with sent_at >= since", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const since = at("2026-03-01T00:00:00Z");
      await seedMessage(b, { tenantId: t, status: "sent", sentAt: since });
      await seedMessage(b, { tenantId: t, status: "sent", sentAt: at("2026-03-01T10:00:00Z") });
      await seedMessage(b, { tenantId: t, status: "sent", sentAt: at("2026-02-28T23:59:59.999Z") });
      await seedMessage(b, { tenantId: t, status: "sending", sentAt: at("2026-03-01T10:00:00Z") });
      await seedMessage(b, { tenantId: other, status: "sent", sentAt: at("2026-03-01T10:00:00Z") });
      expect(await b.store.workerDrain.countSentSince(t, since)).toBe(2);
      expect(await b.store.workerDrain.countSentSince(await b.newTenant(), since)).toBe(0);
    });

    describe("CAS from sending", () => {
      it("releaseClaim: sending -> approved", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.releaseClaim(id, NOW)).toBe(true);
        expect(await b.store.workerDrain.releaseClaim(id, NOW)).toBe(false);
        expect(await getMessage(b, id)).toMatchObject({ status: "approved", updatedAt: NOW });
      });

      it("deferClaim: sending -> approved with scheduled_send_at", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const sendAt = at("2026-03-02T08:00:00Z");
        expect(await b.store.workerDrain.deferClaim(id, sendAt, NOW)).toBe(true);
        expect(await b.store.workerDrain.deferClaim(id, sendAt, NOW)).toBe(false);
        expect(await getMessage(b, id)).toMatchObject({ status: "approved", scheduledSendAt: sendAt, updatedAt: NOW });
      });

      it("markSuppressed: sending -> suppressed", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.markSuppressed(id, NOW)).toBe(true);
        expect(await b.store.workerDrain.markSuppressed(id, NOW)).toBe(false);
        expect((await getMessage(b, id)).status).toBe("suppressed");
      });

      it("setRecipientAddress only while sending", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const approved = await seedMessage(b, { tenantId: t, status: "approved" });
        expect(await b.store.workerDrain.setRecipientAddress(id, "a@b.com", NOW)).toBe(true);
        expect(await b.store.workerDrain.setRecipientAddress(id, "c@d.com", NOW)).toBe(true);
        expect(await b.store.workerDrain.setRecipientAddress(approved, "a@b.com", NOW)).toBe(false);
        expect(await getMessage(b, id)).toMatchObject({ status: "sending", recipientAddress: "c@d.com" });
        expect((await getMessage(b, approved)).recipientAddress).toBeNull();
      });

      it("setRecipientAddress records the transport when given", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const transportId = randomUUID();
        expect(await b.store.workerDrain.setRecipientAddress(id, "a@b.com", NOW, transportId)).toBe(true);
        expect(await getMessage(b, id)).toMatchObject({ recipientAddress: "a@b.com", transportId });
        expect(await b.store.workerDrain.setRecipientAddress(id, "a@b.com", NOW, null)).toBe(true);
        expect((await getMessage(b, id)).transportId).toBe(transportId);
      });

      it("markSent: sending -> sent with sent_at and provider id", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const noProvider = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.markSent(id, "prov-1", NOW)).toBe(true);
        expect(await b.store.workerDrain.markSent(id, "prov-2", NOW)).toBe(false);
        expect(await b.store.workerDrain.markSent(noProvider, null, NOW)).toBe(true);
        expect(await getMessage(b, id)).toMatchObject({ status: "sent", sentAt: NOW, providerMessageId: "prov-1", updatedAt: NOW });
        expect(await getMessage(b, noProvider)).toMatchObject({ status: "sent", providerMessageId: null });
      });

      it("markFailed: sending -> failed", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const sent = await seedMessage(b, { tenantId: t, status: "sent" });
        expect(await b.store.workerDrain.markFailed(id, NOW)).toBe(true);
        expect(await b.store.workerDrain.markFailed(id, NOW)).toBe(false);
        expect(await b.store.workerDrain.markFailed(sent, NOW)).toBe(false);
        expect((await getMessage(b, id)).status).toBe("failed");
        expect((await getMessage(b, sent)).status).toBe("sent");
      });

      it("concurrent transitions: exactly one wins", async () => {
        const t = await b.newTenant();
        const id = await seedMessage(b, { tenantId: t, status: "sending" });
        const results = await Promise.all([
          b.store.workerDrain.markSent(id, "p", NOW),
          b.store.workerDrain.markFailed(id, NOW),
          b.store.workerDrain.markSuppressed(id, NOW),
          b.store.workerDrain.releaseClaim(id, NOW),
          b.store.workerDrain.deferClaim(id, NOW, NOW),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    it("getContact returns email and properties", async () => {
      const t = await b.newTenant();
      const c = await seedContact(b, t, { email: "x@y.com", properties: { plan: "pro", n: 1 } });
      const bare = await seedContact(b, t, { email: null, properties: null });
      expect(await b.store.workerDrain.getContact(c)).toEqual({ email: "x@y.com", properties: { plan: "pro", n: 1 } });
      expect(await b.store.workerDrain.getContact(bare)).toEqual({ email: null, properties: null });
      expect(await b.store.workerDrain.getContact(MISSING)).toBeNull();
    });

    it("isSuppressed matches the tenant's suppressions case-insensitively", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      await b.db.insert(b.schema.suppressions).values([
        { tenantId: t, email: "Blocked@Example.com", reason: "unsubscribe" },
        { tenantId: other, email: "only-other@example.com", reason: "manual" },
      ]);
      expect(await b.store.workerDrain.isSuppressed(t, "blocked@example.com")).toBe(true);
      expect(await b.store.workerDrain.isSuppressed(t, "BLOCKED@EXAMPLE.COM")).toBe(true);
      expect(await b.store.workerDrain.isSuppressed(t, "fine@example.com")).toBe(false);
      expect(await b.store.workerDrain.isSuppressed(t, "only-other@example.com")).toBe(false);
    });

    it("getFlowThrottleInfo returns class and compiled plan", async () => {
      const t = await b.newTenant();
      const plan = { steps: [{ order: 1, wait: "1d" }], frequency: { maxPerDay: 1 } };
      const f = await seedFlow(b, t, { flowClass: "critical", compiledPlan: plan });
      const plain = await seedFlow(b, t);
      expect(await b.store.workerDrain.getFlowThrottleInfo(f)).toEqual({ flowClass: "critical", compiledPlan: plan });
      expect(await b.store.workerDrain.getFlowThrottleInfo(plain)).toEqual({ flowClass: "nurture", compiledPlan: null });
      expect(await b.store.workerDrain.getFlowThrottleInfo(MISSING)).toBeNull();
    });

    it("getTenantSettings and getTenant return settings JSON and name", async () => {
      const t = await b.newTenant("Settings Co");
      const settings = { throttle: { maxPerDay: 2, quietHours: null }, timezone: "UTC" };
      const { eq } = await import("drizzle-orm");
      await b.db.update(b.schema.tenants).set({ settings }).where(eq(b.schema.tenants.id, t));
      const bare = await b.newTenant("Bare");
      expect(await b.store.workerDrain.getTenantSettings(t)).toEqual(settings);
      expect(await b.store.workerDrain.getTenantSettings(bare)).toBeNull();
      expect(await b.store.workerDrain.getTenantSettings(MISSING)).toBeNull();
      expect(await b.store.workerDrain.getTenant(t)).toEqual({ name: "Settings Co", settings, publicHost: null, locale: null });
      expect(await b.store.workerDrain.getTenant(bare)).toEqual({ name: "Bare", settings: null, publicHost: null, locale: null });
      expect(await b.store.workerDrain.getTenant(MISSING)).toBeNull();
    });

    it("getTenant returns the product's public host", async () => {
      const t = await b.newTenant("Hosted");
      const host = `news-${t.slice(0, 8)}.example.com`;
      await b.db.update(b.schema.tenants).set({ publicHost: host }).where(eq(b.schema.tenants.id, t));
      expect(await b.store.workerDrain.getTenant(t)).toEqual({ name: "Hosted", settings: null, publicHost: host, locale: null });
    });

    it("getRecentSends counts sending/sent messages in the last 24h and 7d", async () => {
      const t = await b.newTenant();
      const c = await seedContact(b, t);
      const since24h = at("2026-02-28T12:00:00Z");
      const since7d = at("2026-02-22T12:00:00Z");
      const latest = at("2026-03-01T11:00:00Z");
      await seedMessage(b, { tenantId: t, contactId: c, status: "sent", sentAt: latest });
      await seedMessage(b, { tenantId: t, contactId: c, status: "sending", sentAt: since24h });
      await seedMessage(b, { tenantId: t, contactId: c, status: "sent", sentAt: at("2026-02-25T00:00:00Z") });
      await seedMessage(b, { tenantId: t, contactId: c, status: "sent", sentAt: since7d });
      await seedMessage(b, { tenantId: t, contactId: c, status: "sent", sentAt: at("2026-02-20T00:00:00Z") });
      await seedMessage(b, { tenantId: t, contactId: c, status: "failed", sentAt: latest });
      await seedMessage(b, { tenantId: t, status: "sent", sentAt: latest });
      expect(await b.store.workerDrain.getRecentSends(c, since24h, since7d)).toEqual({
        countLast24h: 2,
        countLast7d: 4,
        lastSentAt: latest,
      });
      const none = await seedContact(b, t);
      expect(await b.store.workerDrain.getRecentSends(none, since24h, since7d)).toEqual({
        countLast24h: 0,
        countLast7d: 0,
        lastSentAt: null,
      });
    });
  });
}
