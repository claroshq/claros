/**
 * Contract tests for workerContextContact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

/** pg raw SQL may return timestamps as strings; callers normalise with new Date(). */
const asDate = (v: Date | string | null) => (v === null ? null : new Date(v));

for (const factory of testBackends()) {
  describe(`workerContextContact on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getContact returns the contact columns, tenant-scoped", async () => {
      const t = await b.newTenant();
      const first = new Date("2026-01-02T03:04:05.678Z");
      const c = await insertContact(b, t, {
        name: "Ada",
        email: "ada@example.com",
        company: "Acme",
        properties: { plan: "pro", seats: 3, nested: { a: null } },
        lifecycleState: "engaged",
        engagementDepth: "power",
        paymentStatus: "paid",
        firstSeenAt: first,
        lastSeenAt: null,
      });
      const row = await b.store.workerContextContact.getContact({ tenantId: t, contactId: c });
      expect(row).not.toBeNull();
      expect({ ...row!, first_seen_at: asDate(row!.first_seen_at), last_seen_at: asDate(row!.last_seen_at) }).toEqual({
        name: "Ada",
        email: "ada@example.com",
        company: "Acme",
        properties: { plan: "pro", seats: 3, nested: { a: null } },
        lifecycle_state: "engaged",
        engagement_depth: "power",
        payment_status: "paid",
        first_seen_at: first,
        last_seen_at: null,
      });

      const bare = await insertContact(b, t);
      const bareRow = await b.store.workerContextContact.getContact({ tenantId: t, contactId: bare });
      expect(bareRow).toMatchObject({ name: null, email: null, properties: null, engagement_depth: null, payment_status: "free" });
      expect(await b.store.workerContextContact.getContact({ tenantId: await b.newTenant(), contactId: c })).toBeNull();
    });

    it("getPriorContactStats aggregates the contact's messages", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const msg = (step: number, values: Record<string, unknown>) =>
        insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: step, ...values });
      await msg(1, { status: "sent", sentAt: new Date("2026-11-01T00:00:00Z"), feedback: "opened", brainActionType: "welcome" });
      await msg(2, { status: "sent", sentAt: new Date("2026-11-05T00:00:00Z"), feedback: "clicked", brainActionType: "nudge" });
      await msg(3, { status: "sent", sentAt: new Date("2026-11-03T00:00:00Z"), feedback: "bounced", brainActionType: "tip" });
      await msg(4, { status: "failed", feedback: "clicked", brainActionType: "late" });
      await msg(5, { status: "pending_generation" });

      const stats = await b.store.workerContextContact.getPriorContactStats({ tenantId: t, contactId: c });
      expect({ ...stats, last_sent_at: asDate(stats.last_sent_at) }).toEqual({
        total_sent: "3",
        messages_opened: "3",
        messages_clicked: "2",
        last_sent_at: new Date("2026-11-05T00:00:00Z"),
        last_action_type: "nudge",
      });

      const none = await b.store.workerContextContact.getPriorContactStats({
        tenantId: t,
        contactId: await insertContact(b, t),
      });
      expect(none).toEqual({
        total_sent: "0",
        messages_opened: "0",
        messages_clicked: "0",
        last_sent_at: null,
        last_action_type: null,
      });
    });
  });
}
