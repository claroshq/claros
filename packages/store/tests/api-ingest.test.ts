/**
 * Contract tests for apiIngest (packages/api/src/routes/ingest.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import type { IngestTraitPlan } from "../src/areas/api-ingest.js";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const TS = new Date("2026-11-20T09:59:00.000Z");

function emptyPlan(over: Partial<IngestTraitPlan> = {}): IngestTraitPlan {
  return { columnUpdates: {}, propsToMerge: {}, keysToRemove: [], conflicts: [], ...over };
}

for (const factory of testBackends()) {
  describe(`apiIngest on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const track = (tenantId: string, userId: string, eventName: string, extra: { messageId?: string; now?: Date } = {}) =>
      b.store.apiIngest.recordTrackEvent({
        tenantId,
        userId,
        eventName,
        properties: { plan: "pro", n: 1 },
        context: { ip: "1.2.3.4" },
        messageId: extra.messageId,
        timestamp: TS,
        now: extra.now ?? NOW,
      });

    const identify = (
      tenantId: string,
      userId: string,
      traitPlan: IngestTraitPlan | null,
      extra: { messageId?: string; traits?: Record<string, unknown> | null } = {},
    ) =>
      b.store.apiIngest.recordIdentifyEvent({
        tenantId,
        userId,
        traits: extra.traits === undefined ? { any: "trait" } : extra.traits,
        traitPlan,
        context: null,
        messageId: extra.messageId,
        timestamp: TS,
        now: NOW,
      });

    async function contactOf(tenantId: string, externalId: string) {
      const c = b.schema.contacts;
      const rows = await b.db
        .select()
        .from(c)
        .where(and(eq(c.tenantId, tenantId), eq(c.externalId, externalId)));
      return rows[0];
    }

    async function eventsOf(tenantId: string) {
      const e = b.schema.events;
      return b.db.select().from(e).where(eq(e.tenantId, tenantId)).orderBy(asc(e.timestamp), asc(e.eventName));
    }

    async function transitionsOf(tenantId: string) {
      const t = b.schema.lifecycleTransitions;
      return b.db.select().from(t).where(eq(t.tenantId, tenantId));
    }

    async function conflictsOf(tenantId: string) {
      const t = b.schema.contactConflicts;
      return b.db.select().from(t).where(eq(t.tenantId, tenantId)).orderBy(asc(t.field));
    }

    async function setActivationEvents(tenantId: string, names: string[]) {
      const t = b.schema.tenants;
      await b.db.update(t).set({ settings: { lifecycle: { activation_events: names } } }).where(eq(t.id, tenantId));
    }

    async function insertContact(tenantId: string, values: Record<string, unknown>) {
      const [row] = await b.db
        .insert(b.schema.contacts)
        .values({ tenantId, lifecycleState: "signed_up", ...values })
        .returning({ id: b.schema.contacts.id });
      return row.id as string;
    }

    describe("recordTrackEvent", () => {
      it("creates a signed_up contact and the event on first sight", async () => {
        const t = await b.newTenant();
        const result = await track(t, "u1", "opened");
        expect(result.deduplicated).toBe(false);

        const contact = await contactOf(t, "u1");
        expect(result).toEqual({ deduplicated: false, contactId: contact.id });
        expect(contact.lifecycleState).toBe("signed_up");
        expect(contact.eventCountBucketCurrent).toBe(1);
        expect(contact.firstSeenAt).toEqual(NOW);
        expect(contact.lastSeenAt).toEqual(NOW);
        expect(contact.paymentStatus).toBe("free");
        expect(contact.createdAt).toBeInstanceOf(Date);

        const evs = await eventsOf(t);
        expect(evs).toHaveLength(1);
        expect(evs[0]).toMatchObject({
          contactId: contact.id,
          type: "track",
          eventName: "opened",
          properties: { plan: "pro", n: 1 },
          context: { ip: "1.2.3.4" },
          messageId: null,
          timestamp: TS,
        });
        expect(evs[0].receivedAt).toBeInstanceOf(Date);
        expect(await transitionsOf(t)).toEqual([]);
      });

      it("updates last_seen_at and the event counter of an existing contact", async () => {
        const t = await b.newTenant();
        const id = await insertContact(t, { externalId: "u1", eventCountBucketCurrent: 4, lastSeenAt: new Date("2026-01-01T00:00:00Z") });
        const result = await track(t, "u1", "opened");
        expect(result).toEqual({ deduplicated: false, contactId: id });
        const contact = await contactOf(t, "u1");
        expect(contact.eventCountBucketCurrent).toBe(5);
        expect(contact.lastSeenAt).toEqual(NOW);
      });

      it("records every event when there is no messageId", async () => {
        const t = await b.newTenant();
        await track(t, "u1", "a");
        await track(t, "u1", "a");
        expect(await eventsOf(t)).toHaveLength(2);
        expect((await contactOf(t, "u1")).eventCountBucketCurrent).toBe(2);
      });

      it("deduplicates a repeated messageId and changes nothing", async () => {
        const t = await b.newTenant();
        const first = await track(t, "u1", "a", { messageId: "m-1" });
        expect(first.deduplicated).toBe(false);
        const again = await track(t, "u1", "a", { messageId: "m-1", now: new Date(NOW.getTime() + 1000) });
        expect(again).toEqual({ deduplicated: true });
        const evs = await eventsOf(t);
        expect(evs).toHaveLength(1);
        expect(evs[0].messageId).toBe("m-1");
        const contact = await contactOf(t, "u1");
        expect(contact.eventCountBucketCurrent).toBe(1);
        expect(contact.lastSeenAt).toEqual(NOW);
        // Same messageId in another tenant is not a duplicate.
        const other = await b.newTenant();
        expect((await track(other, "u1", "a", { messageId: "m-1" })).deduplicated).toBe(false);
      });

      it("inserts a messageId exactly once under concurrent calls", async () => {
        const t = await b.newTenant();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => track(t, "u1", "a", { messageId: "m-race" })),
        );
        expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
        expect(results.filter((r) => r.deduplicated)).toHaveLength(5);
        expect(await eventsOf(t)).toHaveLength(1);
        expect((await contactOf(t, "u1")).eventCountBucketCurrent).toBe(1);
      });

      it("activates a signed_up contact once all activation events are seen", async () => {
        const t = await b.newTenant();
        await setActivationEvents(t, ["created_project", "invited_member"]);
        await track(t, "u1", "created_project");
        await track(t, "u1", "unrelated");
        let contact = await contactOf(t, "u1");
        expect(contact.lifecycleState).toBe("signed_up");
        expect(contact.activatedAt).toBeNull();
        expect(await transitionsOf(t)).toEqual([]);

        const later = new Date(NOW.getTime() + 60_000);
        await track(t, "u1", "invited_member", { now: later });
        contact = await contactOf(t, "u1");
        expect(contact.lifecycleState).toBe("activated");
        expect(contact.activatedAt).toEqual(later);

        const trs = await transitionsOf(t);
        const evs = await eventsOf(t);
        const trigger = evs.find((e: { eventName: string }) => e.eventName === "invited_member");
        expect(trs).toHaveLength(1);
        expect(trs[0]).toMatchObject({
          contactId: contact.id,
          fromState: "signed_up",
          toState: "activated",
          triggerEventId: trigger.id,
          metadata: null,
          transitionedAt: later,
        });
      });

      it("activates a new contact whose first event satisfies a single activation event", async () => {
        const t = await b.newTenant();
        await setActivationEvents(t, ["signup_done"]);
        await track(t, "u1", "signup_done");
        expect((await contactOf(t, "u1")).lifecycleState).toBe("activated");
        expect(await transitionsOf(t)).toHaveLength(1);
      });

      it("does not activate without configured activation events", async () => {
        const t = await b.newTenant();
        await track(t, "u1", "anything");
        expect((await contactOf(t, "u1")).lifecycleState).toBe("signed_up");
      });

      it("moves activated/at_risk/dormant to engaged and churned to resurrected; engaged and resurrected stay", async () => {
        const t = await b.newTenant();
        const cases: Array<[string, string]> = [
          ["activated", "engaged"],
          ["at_risk", "engaged"],
          ["dormant", "engaged"],
          ["churned", "resurrected"],
          ["engaged", "engaged"],
          ["resurrected", "resurrected"],
        ];
        for (const [from] of cases) await insertContact(t, { externalId: `c-${from}`, lifecycleState: from });
        for (const [from] of cases) await track(t, `c-${from}`, "ping");
        for (const [from, to] of cases) expect((await contactOf(t, `c-${from}`)).lifecycleState).toBe(to);
        const trs = await transitionsOf(t);
        expect(trs.map((r: { fromState: string; toState: string }) => `${r.fromState}>${r.toState}`).sort()).toEqual([
          "activated>engaged",
          "at_risk>engaged",
          "churned>resurrected",
          "dormant>engaged",
        ]);
        // activated_at is only set on signed_up -> activated.
        expect((await contactOf(t, "c-activated")).activatedAt).toBeNull();
      });

      it("writes one transition when two events race on the same contact", async () => {
        const t = await b.newTenant();
        await insertContact(t, { externalId: "u1", lifecycleState: "dormant" });
        await Promise.all([track(t, "u1", "a"), track(t, "u1", "b")]);
        expect((await contactOf(t, "u1")).lifecycleState).toBe("engaged");
        expect(await transitionsOf(t)).toHaveLength(1);
        expect(await eventsOf(t)).toHaveLength(2);
      });
    });

    describe("recordIdentifyEvent", () => {
      it("only ensures the contact when the trait plan is null and stores traits as event properties", async () => {
        const t = await b.newTenant();
        const result = await identify(t, "u1", null, { traits: null });
        expect(result).toEqual({ deduplicated: false });
        const contact = await contactOf(t, "u1");
        expect(contact).toMatchObject({ lifecycleState: "signed_up", eventCountBucketCurrent: 1, properties: null, email: null });
        const evs = await eventsOf(t);
        expect(evs).toHaveLength(1);
        expect(evs[0]).toMatchObject({ type: "identify", eventName: null, properties: null, context: null, contactId: contact.id });
      });

      it("writes reserved columns and stores the raw traits on the event", async () => {
        const t = await b.newTenant();
        await identify(
          t,
          "u1",
          emptyPlan({ columnUpdates: { email: "a@x.io", name: "Ada", company: "Acme", paymentStatus: "paid" } }),
          { traits: { email: "a@x.io", name: "Ada", company: "Acme", plan: "paid" } },
        );
        const contact = await contactOf(t, "u1");
        expect(contact).toMatchObject({ email: "a@x.io", name: "Ada", company: "Acme", paymentStatus: "paid" });
        expect((await eventsOf(t))[0].properties).toEqual({ email: "a@x.io", name: "Ada", company: "Acme", plan: "paid" });

        // Null clears the columns.
        await identify(t, "u1", emptyPlan({ columnUpdates: { email: null, name: null, company: null, paymentStatus: null } }));
        expect(await contactOf(t, "u1")).toMatchObject({ email: null, name: null, company: null, paymentStatus: null });
        expect(await conflictsOf(t)).toEqual([]);
      });

      it("merges properties like jsonb ||: top-level replace, removed keys dropped, nulls kept", async () => {
        const t = await b.newTenant();
        await insertContact(t, {
          externalId: "u1",
          properties: { keep: 1, drop: "x", replaced: { deep: true }, storedNull: null, nested: { a: null, b: [1, null] } },
        });
        await identify(
          t,
          "u1",
          emptyPlan({
            propsToMerge: {
              replaced: { other: 1 },
              obj: { b: null, c: "s" },
              arr: [1, true, null, "x", { y: false }],
              flag: false,
              yes: true,
              str: "text",
              int: 42,
              real: 1.5,
              explicitNull: null,
            },
            keysToRemove: ["drop", "missing"],
          }),
        );
        const contact = await contactOf(t, "u1");
        expect(contact.properties).toEqual({
          keep: 1,
          replaced: { other: 1 },
          storedNull: null,
          nested: { a: null, b: [1, null] },
          obj: { b: null, c: "s" },
          arr: [1, true, null, "x", { y: false }],
          flag: false,
          yes: true,
          str: "text",
          int: 42,
          real: 1.5,
          explicitNull: null,
        });

        // Removal only.
        await identify(t, "u1", emptyPlan({ keysToRemove: ["keep", "obj", "arr", "flag", "yes", "str", "int", "real"] }));
        expect((await contactOf(t, "u1")).properties).toEqual({
          replaced: { other: 1 },
          storedNull: null,
          nested: { a: null, b: [1, null] },
          explicitNull: null,
        });
      });

      it("starts from an empty object when the contact has no properties", async () => {
        const t = await b.newTenant();
        await identify(t, "u1", emptyPlan({ propsToMerge: { a: 1 } }));
        expect((await contactOf(t, "u1")).properties).toEqual({ a: 1 });
        const t2 = await b.newTenant();
        await identify(t2, "u1", emptyPlan({ keysToRemove: ["a"] }));
        expect((await contactOf(t2, "u1")).properties).toEqual({});
      });

      it("rejects an email held by another contact, records conflicts and applies the rest", async () => {
        const t = await b.newTenant();
        await insertContact(t, { externalId: "owner", email: "taken@x.io" });
        await insertContact(t, { externalId: "u1", email: null });
        await identify(
          t,
          "u1",
          emptyPlan({
            columnUpdates: { email: "taken@x.io", name: "Bob" },
            propsToMerge: { k: "v" },
            conflicts: [{ field: "payment_status", rejectedValue: "gold" }],
          }),
        );
        const contact = await contactOf(t, "u1");
        expect(contact).toMatchObject({ email: null, name: "Bob", properties: { k: "v" } });
        expect((await contactOf(t, "owner")).email).toBe("taken@x.io");

        const identifyEvent = (await eventsOf(t))[0];
        const conflicts = await conflictsOf(t);
        expect(conflicts).toHaveLength(2);
        expect(conflicts.map((c: Record<string, unknown>) => ({ field: c.field, rejectedValue: c.rejectedValue, contactId: c.contactId, eventId: c.eventId }))).toEqual([
          { field: "email", rejectedValue: "taken@x.io", contactId: contact.id, eventId: identifyEvent.id },
          { field: "payment_status", rejectedValue: "gold", contactId: contact.id, eventId: identifyEvent.id },
        ]);
        expect(conflicts[0].createdAt).toBeInstanceOf(Date);
      });

      it("accepts the contact's own email again without a conflict", async () => {
        const t = await b.newTenant();
        await insertContact(t, { externalId: "u1", email: "me@x.io" });
        await identify(t, "u1", emptyPlan({ columnUpdates: { email: "me@x.io" } }));
        expect((await contactOf(t, "u1")).email).toBe("me@x.io");
        expect(await conflictsOf(t)).toEqual([]);
      });

      it("gives a contested email to exactly one of two concurrent identifies", async () => {
        const t = await b.newTenant();
        await Promise.all([
          identify(t, "a", emptyPlan({ columnUpdates: { email: "both@x.io" } })),
          identify(t, "b", emptyPlan({ columnUpdates: { email: "both@x.io" } })),
        ]);
        const emails = [(await contactOf(t, "a")).email, (await contactOf(t, "b")).email];
        expect(emails.filter((e) => e === "both@x.io")).toHaveLength(1);
        expect(emails.filter((e) => e === null)).toHaveLength(1);
        const conflicts = await conflictsOf(t);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ field: "email", rejectedValue: "both@x.io" });
      });

      it("deduplicates a repeated messageId, also under concurrent calls", async () => {
        const t = await b.newTenant();
        const plan = emptyPlan({ propsToMerge: { a: 1 }, conflicts: [{ field: "payment_status", rejectedValue: "bad" }] });
        const results = await Promise.all(
          Array.from({ length: 5 }, () => identify(t, "u1", plan, { messageId: "idm-1" })),
        );
        expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
        expect(await eventsOf(t)).toHaveLength(1);
        expect(await conflictsOf(t)).toHaveLength(1);
        expect((await contactOf(t, "u1")).eventCountBucketCurrent).toBe(1);
        expect(await identify(t, "u1", plan, { messageId: "idm-1" })).toEqual({ deduplicated: true });
      });

      it("counts as activity (churned -> resurrected) but never activates", async () => {
        const t = await b.newTenant();
        await setActivationEvents(t, ["x"]);
        await insertContact(t, { externalId: "churned", lifecycleState: "churned" });
        await insertContact(t, { externalId: "new", lifecycleState: "signed_up" });
        await identify(t, "churned", null);
        await identify(t, "new", emptyPlan({ propsToMerge: { a: 1 } }));
        expect((await contactOf(t, "churned")).lifecycleState).toBe("resurrected");
        expect((await contactOf(t, "new")).lifecycleState).toBe("signed_up");
        const trs = await transitionsOf(t);
        expect(trs).toHaveLength(1);
        const ev = (await eventsOf(t)).find((e: { contactId: string }) => e.contactId === trs[0].contactId);
        expect(trs[0]).toMatchObject({ fromState: "churned", toState: "resurrected", triggerEventId: ev.id, transitionedAt: NOW });
      });
    });
  });
}
