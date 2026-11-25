/**
 * Contract tests (every backend) for the G12 suppression API and contact
 * erasure, and the G20 contact exclusion, including the outbox rows they
 * write in the same atomic unit (G5).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage, insertEvent } from "./support/worker-fixtures.js";
import { insertEndpoint, outboxOf } from "./support/outbox-fixtures.js";

const NOW = new Date("2026-11-20T10:00:00Z");

for (const factory of testBackends()) {
  describe(`G12 suppressions / contacts on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("addSuppressions inserts new addresses only (case-insensitive, first wins) and writes contact.suppressed per insert", async () => {
      const t = await b.newTenant();
      const ep = await insertEndpoint(b, t, ["contact.suppressed"]);
      await insertEndpoint(b, t, ["message.sent"]);
      await b.db.insert(b.schema.suppressions).values({ tenantId: t, email: "old@example.com", reason: "manual", source: "admin" });
      const inserted = await b.store.apiSuppressions.addSuppressions({
        tenantId: t,
        emails: ["a@example.com", "OLD@example.com", "A@example.com", "b@example.com"],
        reason: "complaint",
        source: "api",
        now: NOW,
      });
      expect(inserted).toEqual(["a@example.com", "b@example.com"]);
      const rows = await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t));
      expect(rows.map((r: any) => `${r.email}:${r.reason}:${r.source}`).sort()).toEqual([
        "a@example.com:complaint:api",
        "b@example.com:complaint:api",
        "old@example.com:manual:admin",
      ]);
      expect(await outboxOf(b, t)).toEqual([
        { event: "contact.suppressed", payload: { email: "a@example.com", reason: "complaint", source: "api" }, endpointId: ep, dedupKey: null },
        { event: "contact.suppressed", payload: { email: "b@example.com", reason: "complaint", source: "api" }, endpointId: ep, dedupKey: null },
      ]);
      // Without endpoints nothing is written to the outbox.
      const t2 = await b.newTenant();
      expect(await b.store.apiSuppressions.addSuppressions({ tenantId: t2, emails: ["x@example.com"], reason: "manual", source: "api", now: NOW })).toEqual(["x@example.com"]);
      expect(await outboxOf(b, t2)).toEqual([]);
    });

    it("concurrent addSuppressions of one address insert it once and write one event", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["contact.suppressed"]);
      const [x, y] = await Promise.all([
        b.store.apiSuppressions.addSuppressions({ tenantId: t, emails: ["race@example.com"], reason: "manual", source: "api", now: NOW }),
        b.store.apiSuppressions.addSuppressions({ tenantId: t, emails: ["race@example.com"], reason: "manual", source: "api", now: NOW }),
      ]);
      expect([...x, ...y]).toEqual(["race@example.com"]);
      expect((await outboxOf(b, t)).length).toBe(1);
    });

    it("removeSuppression: not_found, protected unless force, deleted with contact.resubscribed", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["contact.resubscribed"]);
      await b.db.insert(b.schema.suppressions).values([
        { tenantId: t, email: "c@example.com", reason: "complaint", source: "webhook" },
        { tenantId: t, email: "m@example.com", reason: "manual", source: "admin" },
      ]);
      const args = { tenantId: t, force: false, protectedReasons: ["complaint", "hard_bounce"], now: NOW };
      expect(await b.store.apiSuppressions.removeSuppression({ ...args, email: "none@example.com" })).toEqual({ result: "not_found", reason: null });
      expect(await b.store.apiSuppressions.removeSuppression({ ...args, email: "C@example.com" })).toEqual({ result: "protected", reason: "complaint" });
      expect(await outboxOf(b, t)).toEqual([]);
      expect(await b.store.apiSuppressions.removeSuppression({ ...args, email: "M@Example.com" })).toEqual({ result: "deleted", reason: "manual" });
      expect(await b.store.apiSuppressions.removeSuppression({ ...args, force: true, email: "c@example.com" })).toEqual({ result: "deleted", reason: "complaint" });
      const left = await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t));
      expect(left).toEqual([]);
      expect((await outboxOf(b, t)).map((r) => r.payload)).toEqual([
        { email: "c@example.com", previous_reason: "complaint" },
        { email: "m@example.com", previous_reason: "manual" },
      ]);
    });

    it("listSuppressions with since returns rows created at or after it", async () => {
      const t = await b.newTenant();
      await b.db.insert(b.schema.suppressions).values([
        { tenantId: t, email: "1@example.com", reason: "manual", createdAt: new Date("2026-11-01T00:00:00Z") },
        { tenantId: t, email: "2@example.com", reason: "manual", createdAt: new Date("2026-11-10T00:00:00Z") },
        { tenantId: t, email: "3@example.com", reason: "manual", createdAt: new Date("2026-11-11T00:00:00Z") },
      ]);
      const rows = await b.store.apiSuppressions.listSuppressions({ tenantId: t, after: null, limit: 10, since: new Date("2026-11-10T00:00:00Z") });
      expect(rows.map((r) => r.email)).toEqual(["2@example.com", "3@example.com"]);
      const page2 = await b.store.apiSuppressions.listSuppressions({
        tenantId: t, after: { createdAt: rows[0]!.createdAt!.toISOString(), id: rows[0]!.id }, limit: 10, since: new Date("2026-11-10T00:00:00Z"),
      });
      expect(page2.map((r) => r.email)).toEqual(["3@example.com"]);
    });

    it("findContactByRef resolves external_id first, then id, tenant scoped", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const c = await insertContact(b, t, { externalId: "user-42", email: "u42@example.com" });
      expect(await b.store.apiContacts.findContactByRef({ tenantId: t, ref: "user-42" })).toEqual({ id: c, externalId: "user-42", email: "u42@example.com" });
      expect(await b.store.apiContacts.findContactByRef({ tenantId: t, ref: c })).toEqual({ id: c, externalId: "user-42", email: "u42@example.com" });
      expect(await b.store.apiContacts.findContactByRef({ tenantId: other, ref: "user-42" })).toBeNull();
      expect(await b.store.apiContacts.findContactByRef({ tenantId: t, ref: "nobody" })).toBeNull();
    });

    it("eraseContact removes the contact and everything about it, keeps suppressions and other contacts", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { email: "erase@example.com" });
      const keep = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const msg = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: 1 });
      await b.db.insert(b.schema.messageEvents).values({ tenantId: t, messageId: msg, eventType: "delivered", occurredAt: NOW });
      await insertEvent(b, { tenantId: t, contactId: c, timestamp: NOW, eventName: "x" });
      await insertEvent(b, { tenantId: t, contactId: keep, timestamp: NOW, eventName: "x" });
      await b.db.insert(b.schema.suppressions).values({ tenantId: t, email: "erase@example.com", reason: "manual" });
      const ep = await insertEndpoint(b, t, ["message.sent"]);
      await b.db.insert(b.schema.webhookOutbox).values([
        { tenantId: t, endpointId: ep, event: "message.sent", payload: { contact_id: c }, nextAttemptAt: NOW, createdAt: NOW },
        { tenantId: t, endpointId: ep, event: "message.sent", payload: { contact_id: keep }, nextAttemptAt: NOW, createdAt: NOW },
      ]);

      expect(await b.store.apiContacts.eraseContact({ tenantId: t, contactId: c })).toBe(true);
      expect(await b.store.apiContacts.eraseContact({ tenantId: t, contactId: c })).toBe(false);
      const contactsLeft = await b.db.select({ id: b.schema.contacts.id }).from(b.schema.contacts).where(eq(b.schema.contacts.tenantId, t));
      expect(contactsLeft.map((r: any) => r.id)).toEqual([keep]);
      const ev = await b.db.select().from(b.schema.events).where(eq(b.schema.events.tenantId, t));
      expect(ev.map((r: any) => r.contactId)).toEqual([keep]);
      expect(await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, t))).toEqual([]);
      expect(await b.db.select().from(b.schema.messageEvents).where(eq(b.schema.messageEvents.tenantId, t))).toEqual([]);
      expect(await b.db.select().from(b.schema.flowMemberships).where(eq(b.schema.flowMemberships.tenantId, t))).toEqual([]);
      expect((await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t))).length).toBe(1);
      expect((await outboxOf(b, t)).map((r) => r.payload)).toEqual([{ contact_id: keep }]);
    });

    it("excludeContact suppresses and cancels not-yet-sent messages atomically; leaves sent and sending", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["contact.suppressed"]);
      const c = await insertContact(b, t, { email: "Ex@Example.com" });
      const f = await insertFlow(b, t);
      const ids: Record<string, string> = {};
      for (const status of ["pending_generation", "pending_approval", "approved", "sending", "sent", "rejected"]) {
        const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: await insertFlow(b, t), status: "completed" });
        ids[status] = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: 1, status });
      }
      const out = await b.store.apiContacts.excludeContact({ tenantId: t, contactId: c, email: "Ex@Example.com", now: NOW });
      expect(out.suppressed).toBe(true);
      expect([...out.cancelled].sort()).toEqual([ids.pending_generation, ids.pending_approval, ids.approved].sort());
      const msgs = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, t));
      const byId = Object.fromEntries(msgs.map((m: any) => [m.id, m]));
      expect(byId[ids.approved!].status).toBe("cancelled");
      expect(byId[ids.approved!].statusReason).toBe("excluded");
      expect(byId[ids.sending!].status).toBe("sending");
      expect(byId[ids.sent!].status).toBe("sent");
      expect((await outboxOf(b, t)).map((r) => r.payload)).toEqual([
        { email: "ex@example.com", reason: "manual", source: "admin", contact_id: c },
      ]);
      // Again: already suppressed, nothing left to cancel, no second event.
      expect(await b.store.apiContacts.excludeContact({ tenantId: t, contactId: c, email: "Ex@Example.com", now: NOW })).toEqual({ suppressed: false, cancelled: [] });
      expect((await outboxOf(b, t)).length).toBe(1);
    });
  });
}
