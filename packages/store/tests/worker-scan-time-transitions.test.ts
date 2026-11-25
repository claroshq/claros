/**
 * Contract tests for workerScanTimeTransitions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, sortedIds } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");

for (const factory of testBackends()) {
  describe(`workerScanTimeTransitions on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("listTenants returns the requested tenants ordered by id", async () => {
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      const rows = await b.store.workerScanTimeTransitions.listTenants([t2, t1]);
      expect(rows.map((r) => r.id)).toEqual(sortedIds([t1, t2]));
      const all = await b.store.workerScanTimeTransitions.listTenants();
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([t1, t2]));
    });

    it("listContactsInStatesPage pages contacts in the given states by id", async () => {
      const t = await b.newTenant();
      const seen = new Date("2026-10-01T00:00:00Z");
      const engaged = await Promise.all(
        [0, 1, 2].map(() => insertContact(b, t, { lifecycleState: "engaged", lastSeenAt: seen })),
      );
      const atRisk = await insertContact(b, t, { lifecycleState: "at_risk" });
      await insertContact(b, t, { lifecycleState: "signed_up" });
      await insertContact(b, await b.newTenant(), { lifecycleState: "engaged" });

      const expected = sortedIds([...engaged, atRisk]);
      const p1 = await b.store.workerScanTimeTransitions.listContactsInStatesPage({
        tenantId: t,
        states: ["engaged", "at_risk"],
        afterId: null,
        limit: 2,
      });
      expect(p1.map((r) => r.id)).toEqual(expected.slice(0, 2));
      const p2 = await b.store.workerScanTimeTransitions.listContactsInStatesPage({
        tenantId: t,
        states: ["engaged", "at_risk"],
        afterId: p1[1]!.id,
        limit: 10,
      });
      expect(p2.map((r) => r.id)).toEqual(expected.slice(2));
      const row = [...p1, ...p2].find((r) => r.id === engaged[0]);
      expect(row).toEqual({ id: engaged[0], lifecycleState: "engaged", lastSeenAt: seen });
      expect([...p1, ...p2].find((r) => r.id === atRisk)!.lastSeenAt).toBeNull();
    });

    it("applyTimeTransition swaps state once and writes one audit row", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t, { lifecycleState: "engaged" });
      const input = { tenantId: t, contactId: c, fromState: "engaged", toState: "at_risk", now };
      const results = await Promise.all([
        b.store.workerScanTimeTransitions.applyTimeTransition(input),
        b.store.workerScanTimeTransitions.applyTimeTransition(input),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const [contact] = await b.db
        .select({ s: b.schema.contacts.lifecycleState })
        .from(b.schema.contacts)
        .where(eq(b.schema.contacts.id, c));
      expect(contact.s).toBe("at_risk");

      const audit = await b.db
        .select()
        .from(b.schema.lifecycleTransitions)
        .where(eq(b.schema.lifecycleTransitions.contactId, c));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: t,
        fromState: "engaged",
        toState: "at_risk",
        triggerEventId: null,
        metadata: { trigger: "scan" },
        transitionedAt: now,
      });

      expect(await b.store.workerScanTimeTransitions.applyTimeTransition(input)).toBe(false);
    });
  });
}
