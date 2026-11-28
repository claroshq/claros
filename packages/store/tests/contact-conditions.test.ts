/**
 * Contract tests (every backend) for the contact-condition lookups (G4,
 * G28): getContactTraits and countSends, on each of the three worker areas
 * that expose them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

for (const factory of testBackends()) {
  describe(`contact condition lookups on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const areas = (b: Backend) => [b.store.workerAdvanceMembership, b.store.workerScanStepAdvancement, b.store.workerTriggerCheck];

    it("getContactTraits returns properties plus reserved columns, null when missing or in another tenant", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { properties: { plan_tier: "pro", n: 3, nested: { a: true } } });
      const bare = await insertContact(b, t);
      for (const q of areas(b)) {
        // payment_status is a reserved trait from its column (default 'free').
        expect(await q.getContactTraits({ tenantId: t, contactId: c })).toEqual({ plan_tier: "pro", n: 3, nested: { a: true }, payment_status: "free" });
        expect(await q.getContactTraits({ tenantId: t, contactId: bare })).toEqual({ payment_status: "free" });
        expect(await q.getContactTraits({ tenantId: await b.newTenant(), contactId: c })).toBeNull();
      }
    });

    it("getContactTraits: reserved columns override stale properties; NULL columns stay absent", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { email: "x@acme.test", company: "Acme", paymentStatus: "past_due", properties: { payment_status: "paid", plan_tier: "pro" } });
      for (const q of areas(b)) {
        expect(await q.getContactTraits({ tenantId: t, contactId: c })).toEqual({ plan_tier: "pro", payment_status: "past_due", email: "x@acme.test", company: "Acme" });
      }
    });

    it("countSends counts sent and sending messages, filtered by flow slug or id, action type, topic and window", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const other = await insertContact(b, t);
      const welcome = await insertFlow(b, t, { slug: "welcome" });
      const nurture = await insertFlow(b, t);
      const topicId = crypto.randomUUID();
      await b.db.insert(b.schema.topics).values({ id: topicId, tenantId: t, slug: "lifecycle", name: "Lifecycle", kind: "lifecycle" });
      const add = async (flowId: string, status: string, sentAt: Date | null, extra: Record<string, unknown> = {}, contactId = c) => {
        const m = await insertMembership(b, { tenantId: t, contactId, flowId, status: "completed" });
        await insertMessage(b, { tenantId: t, contactId, flowId, membershipId: m, flowStepOrder: 1, status, sentAt, ...extra });
      };
      await add(welcome, "sent", new Date("2026-11-01T00:00:00Z"), { brainActionType: "welcome" });
      await add(nurture, "sent", new Date("2026-11-18T00:00:00Z"), { brainActionType: "tip_trick", topicId });
      await add(nurture, "sending", new Date("2026-11-19T00:00:00Z"), { brainActionType: "tip_trick" });
      await add(nurture, "pending_approval", null, { brainActionType: "tip_trick" });
      await add(nurture, "failed", new Date("2026-11-19T00:00:00Z"));
      await add(welcome, "sent", new Date("2026-11-19T00:00:00Z"), {}, other);

      for (const q of areas(b)) {
        const n = (f: Record<string, unknown>) => q.countSends({ tenantId: t, contactId: c, since: null, ...f });
        expect(await n({})).toBe(3);
        expect(await n({ flow: "welcome" })).toBe(1);
        expect(await n({ flow: nurture })).toBe(2);
        expect(await n({ actionType: "tip_trick" })).toBe(2);
        expect(await n({ topic: "lifecycle" })).toBe(1);
        expect(await n({ topic: "nope" })).toBe(0);
        expect(await n({ since: new Date("2026-11-10T00:00:00Z") })).toBe(2);
        expect(await n({ flow: "welcome", since: new Date("2026-11-10T00:00:00Z") })).toBe(0);
        expect(await q.countSends({ tenantId: await b.newTenant(), contactId: c, since: null })).toBe(0);
      }
    });
  });
}
