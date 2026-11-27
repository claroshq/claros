/**
 * Contract tests (every backend): state changes write their outbox rows
 * (G5) in the same atomic unit, only when the change happened, and the
 * delivery claim (workerWebhooks) hands each due row to one caller.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";
import { insertEndpoint, outboxOf } from "./support/outbox-fixtures.js";
import { ANALYTICS_SOURCE_EVENTS, WEBHOOK_EVENTS } from "@claros/core";

const NOW = new Date("2026-11-20T10:00:00Z");
const ALL = [...WEBHOOK_EVENTS, ...ANALYTICS_SOURCE_EVENTS];

for (const factory of testBackends()) {
  describe(`outbox events on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function message(t: string, status: string, extra: Record<string, unknown> = {}) {
      const c = await insertContact(b, t, { email: `${randomUUID().slice(0, 6)}@example.com` });
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: 1, status, ...extra });
      return { id, c, f, m };
    }
    const ev = (t: string, event: string, payload: Record<string, unknown>) => ({ tenantId: t, outbox: [{ event, payload }] });

    it("drain markSent / markFailed write their event only when the CAS wins", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ALL);
      const s = await message(t, "sending");
      expect(await b.store.workerDrain.markSent(s.id, "pm-1", NOW, null, ev(t, "message.sent", { message_id: s.id }))).toBe(true);
      expect(await b.store.workerDrain.markSent(s.id, "pm-1", NOW, null, ev(t, "message.sent", { message_id: s.id }))).toBe(false);
      const f = await message(t, "sending");
      expect(await b.store.workerDrain.markFailed(f.id, NOW, "x", ev(t, "message.failed", { message_id: f.id, reason: "x" }))).toBe(true);
      const g = await message(t, "approved");
      expect(await b.store.workerDrain.markFailed(g.id, NOW, "x", ev(t, "message.failed", { message_id: g.id }))).toBe(false);
      expect((await outboxOf(b, t)).map((r) => `${r.event}:${r.payload.message_id}`).sort()).toEqual([`message.failed:${f.id}`, `message.sent:${s.id}`].sort());
    });

    it("resend webhook feedback, delivery events and suppressions write events once", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ALL);
      const m = await message(t, "sent");
      const e = (event: string) => ({ tenantId: t, now: NOW, outbox: [{ event, payload: { message_id: m.id } }] });
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: m.id, feedback: "opened", predecessors: [null], events: e("message.opened") })).toBe(true);
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: m.id, feedback: "opened", predecessors: [null], events: e("message.opened") })).toBe(false);
      expect(await b.store.apiResendWebhook.setTerminalFeedback({ messageId: m.id, feedback: "bounced", events: e("message.bounced") })).toBe(true);
      expect(await b.store.apiResendWebhook.setTerminalFeedback({ messageId: m.id, feedback: "complained", events: e("message.complained") })).toBe(false);
      const evArgs = { tenantId: t, messageId: m.id, eventType: "delivered", occurredAt: NOW.toISOString(), providerEventId: "pe-1", metadataJson: null, events: e("message.delivered") };
      await b.store.apiResendWebhook.insertMessageEvent(evArgs);
      await b.store.apiResendWebhook.insertMessageEvent(evArgs);
      const sup = { tenantId: t, email: "bounce@example.com", reason: "hard_bounce" as const, events: { tenantId: t, now: NOW, outbox: [{ event: "contact.suppressed", payload: { email: "bounce@example.com" } }] } };
      await b.store.apiResendWebhook.insertSuppression(sup);
      await b.store.apiResendWebhook.insertSuppression(sup);
      expect((await outboxOf(b, t)).map((r) => r.event).sort()).toEqual(
        ["contact.suppressed", "message.bounced", "message.delivered", "message.opened"].sort(),
      );
    });

    it("unsubscribe: suppressAddress writes once; topic status changes write their events", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ALL);
      const c = await insertContact(b, t);
      const topicId = randomUUID();
      await b.db.insert(b.schema.topics).values({ id: topicId, tenantId: t, slug: "news", name: "News", kind: "marketing" });
      const out = [{ event: "contact.unsubscribed", payload: { contact_id: c, scope: "product" } }];
      await b.store.apiUnsubscribe.suppressAddress({ tenantId: t, email: "u@example.com", reason: "unsubscribe", source: "page", outbox: out, now: NOW });
      await b.store.apiUnsubscribe.suppressAddress({ tenantId: t, email: "U@example.com", reason: "unsubscribe", source: "page", outbox: out, now: NOW });
      await b.store.apiUnsubscribe.setContactTopicStatuses({
        tenantId: t, contactId: c, statuses: [{ topicId, status: "unsubscribed" }], source: "page", now: NOW,
        outbox: [{ event: "contact.unsubscribed", payload: { contact_id: c, scope: "topic", topic: "news" } }],
      });
      const rows = await outboxOf(b, t);
      expect(rows.map((r) => r.payload.scope).sort()).toEqual(["product", "topic"]);
      const status = await b.db.select().from(b.schema.contactTopics).where(eq(b.schema.contactTopics.contactId, c));
      expect(status[0].status).toBe("unsubscribed");
    });

    it("enrollment writes flow.enrolled and, on priority eviction, flow.exited", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["flow.enrolled", "flow.exited"]);
      const c = await insertContact(b, t);
      const low = await insertFlow(b, t, { flowClass: "nurture", priority: 1 });
      const high = await insertFlow(b, t, { flowClass: "nurture", priority: 5 });
      const crit = await insertFlow(b, t, { flowClass: "critical" });
      const flow = (id: string, priority: number, flowClass: "nurture" | "critical") => ({
        id, tenantId: t, priority, triggerType: "event" as const, triggerConfig: {}, flowClass, reentryPolicy: "every_time" as const, reentryCooldownDays: 0,
      });
      const r1 = await b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [flow(low, 1, "nurture"), flow(crit, 0, "critical")], now: NOW });
      expect(r1.filter((r) => r.enrolled).length).toBe(2);
      const r2 = await b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [flow(high, 5, "nurture")], now: new Date(NOW.getTime() + 1000) });
      expect(r2[0]).toMatchObject({ enrolled: true });
      const rows = await outboxOf(b, t);
      const enrolled = rows.filter((r) => r.event === "flow.enrolled").map((r) => r.payload.flow_id).sort();
      expect(enrolled).toEqual([low, crit, high].sort());
      const exited = rows.filter((r) => r.event === "flow.exited");
      expect(exited.length).toBe(1);
      expect(exited[0]!.payload).toMatchObject({ contact_id: c, reason: "priority_override" });
      expect((r1.find((r) => r.enrolled && "membershipId" in r) as { membershipId: string }).membershipId).toBeTruthy();
    });

    it("exitMembership writes flow.exited only when the membership was active", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["flow.exited"]);
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const e = ev(t, "flow.exited", { membership_id: m, reason: "condition_met" });
      await b.store.workerAdvanceMembership.exitMembership({ membershipId: m, now: NOW, exitReason: "condition_met", clearConditionError: false, events: e });
      await b.store.workerScanStepAdvancement.exitMembership({ membershipId: m, now: NOW, exitReason: "condition_met", clearConditionError: false, events: e });
      expect((await outboxOf(b, t)).length).toBe(1);
    });

    it("delivery claim: due rows to one caller, lease, delivered and failed marks, subject description", async () => {
      const t = await b.newTenant();
      const ep = await insertEndpoint(b, t, ALL, { secret: "enc", config: { sink: "statsraven" } });
      const m = await message(t, "pending_approval", { subject: "Hi", brainActionType: "welcome" });
      const later = new Date(NOW.getTime() + 3600_000);
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await b.db.insert(b.schema.webhookOutbox).values([
        { id: ids[0], tenantId: t, endpointId: ep, event: "message.sent", payload: { message_id: m.id }, nextAttemptAt: NOW, createdAt: NOW },
        { id: ids[1], tenantId: t, endpointId: ep, event: "message.sent", payload: { message_id: m.id }, nextAttemptAt: NOW, createdAt: NOW },
        { id: ids[2], tenantId: t, endpointId: ep, event: "message.sent", payload: {}, nextAttemptAt: later, createdAt: NOW },
      ]);
      const at = new Date(NOW.getTime() + 1000);
      // The claim is global: a high limit so due rows other tests left in a
      // shared database cannot take the slots of this tenant's rows.
      const [x, y] = await Promise.all([
        b.store.workerWebhooks.claimDueDeliveries({ now: at, limit: 1000, leaseMs: 60_000 }),
        b.store.workerWebhooks.claimDueDeliveries({ now: at, limit: 1000, leaseMs: 60_000 }),
      ]);
      const mine = [...x, ...y].filter((r) => r.tenantId === t);
      expect(mine.map((r) => r.id).sort()).toEqual([ids[0], ids[1]].sort());
      expect(mine[0]).toMatchObject({ attempts: 1, tenantSlug: expect.stringMatching(/^t-/), endpoint: { id: ep, kind: "webhook", secret: "enc", config: { sink: "statsraven" } } });
      // Leased: not claimable again until the lease ends.
      expect((await b.store.workerWebhooks.claimDueDeliveries({ now: at, limit: 1000, leaseMs: 60_000 })).filter((r) => r.tenantId === t)).toEqual([]);
      await b.store.workerWebhooks.markDelivered({ id: ids[0]!, now: at });
      await b.store.workerWebhooks.markAttemptFailed({ id: ids[1]!, error: "HTTP 500", nextAttemptAt: null, now: at });
      const rows = await b.db.select().from(b.schema.webhookOutbox).where(eq(b.schema.webhookOutbox.tenantId, t));
      const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
      expect(byId[ids[0]!].status).toBe("delivered");
      expect(byId[ids[1]!]).toMatchObject({ status: "dead", lastError: "HTTP 500" });

      const subject = await b.store.workerWebhooks.describeSubject({ tenantId: t, messageId: m.id });
      expect(subject).toMatchObject({
        message: { id: m.id, subject: "Hi", actionType: "welcome", step: 1, status: "pending_approval" },
        contact: { id: m.c, externalId: `ext-${m.c}` },
        flow: { id: m.f },
        topic: null,
      });
      expect((await b.store.workerWebhooks.describeSubject({ tenantId: t, membershipId: m.m })).contact?.id).toBe(m.c);
      expect((await b.store.workerWebhooks.describeSubject({ tenantId: await b.newTenant(), messageId: m.id })).message).toBeNull();
      expect(await b.store.workerWebhooks.countPendingApprovals(t)).toBe(1);
    });
  });
}
