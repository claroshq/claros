/**
 * Contract tests for workerScanSegmentEnrollment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, sortedIds } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(now.getTime() - days * DAY);

for (const factory of testBackends()) {
  describe(`workerScanSegmentEnrollment on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("listTenants returns the requested tenants ordered by id, with settings", async () => {
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ settings: { a: 1 } }).where(eq(b.schema.tenants.id, t1));
      const rows = await b.store.workerScanSegmentEnrollment.listTenants([t2, t1]);
      expect(rows.map((r) => r.id)).toEqual(sortedIds([t1, t2]));
      expect(rows.find((r) => r.id === t1)!.settings).toEqual({ a: 1 });
      expect(rows.find((r) => r.id === t2)!.settings).toBeNull();

      const all = await b.store.workerScanSegmentEnrollment.listTenants();
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([t1, t2]));
      expect(all.map((r) => r.id)).toEqual(sortedIds(all.map((r) => r.id)));
      const empty = await b.store.workerScanSegmentEnrollment.listTenants([]);
      expect(empty.map((r) => r.id)).toEqual(expect.arrayContaining([t1, t2]));
    });

    it("listActiveSegmentFlows returns active compiled segment flows only", async () => {
      const t = await b.newTenant();
      const ready = { status: "active", triggerType: "segment", compileStatus: "ready", compiledPlan: {} };
      const f = await insertFlow(b, t, { ...ready, priority: 2 });
      await insertFlow(b, t, { ...ready, triggerType: "event" });
      await insertFlow(b, t, { ...ready, compileStatus: "pending" });
      const rows = await b.store.workerScanSegmentEnrollment.listActiveSegmentFlows(t);
      expect(rows).toEqual([
        {
          id: f,
          tenantId: t,
          priority: 2,
          triggerType: "segment",
          triggerConfig: { event: "x" },
          flowClass: "nurture",
          reentryPolicy: "cooldown",
          reentryCooldownDays: 30,
        },
      ]);
    });

    it("listCellContactsPage filters by tenure/recency cell, skips active members, pages by id", async () => {
      const t = await b.newTenant();
      const flowId = await insertFlow(b, t);
      // In the cell: tenure [10, 40) days, recency [5, 20) days.
      const inCell = await Promise.all(
        [0, 1, 2].map(() => insertContact(b, t, { firstSeenAt: ago(20), lastSeenAt: ago(10) })),
      );
      // Boundaries: min inclusive, max exclusive.
      const atMin = await insertContact(b, t, { firstSeenAt: ago(10), lastSeenAt: ago(5) });
      await insertContact(b, t, { firstSeenAt: ago(40), lastSeenAt: ago(10) }); // tenure == max: out
      await insertContact(b, t, { firstSeenAt: ago(20), lastSeenAt: ago(20) }); // recency == max: out
      await insertContact(b, t, { firstSeenAt: ago(9), lastSeenAt: ago(6) }); // too new
      await insertContact(b, t, { firstSeenAt: null, lastSeenAt: ago(10) }); // no first_seen
      const member = await insertContact(b, t, { firstSeenAt: ago(20), lastSeenAt: ago(10) });
      await insertMembership(b, { tenantId: t, contactId: member, flowId });
      const exitedMember = await insertContact(b, t, { firstSeenAt: ago(20), lastSeenAt: ago(10) });
      await insertMembership(b, { tenantId: t, contactId: exitedMember, flowId, status: "exited" });

      const expected = sortedIds([...inCell, atMin, exitedMember]);
      const q = {
        tenantId: t,
        flowId,
        now,
        tenure: { minDays: 10, maxDays: 40 },
        recency: { minDays: 5, maxDays: 20 },
      };
      const page1 = await b.store.workerScanSegmentEnrollment.listCellContactsPage({ ...q, afterId: null, limit: 3 });
      expect(page1).toEqual(expected.slice(0, 3).map((id) => ({ id })));
      const page2 = await b.store.workerScanSegmentEnrollment.listCellContactsPage({
        ...q,
        afterId: page1[2]!.id,
        limit: 3,
      });
      expect(page2).toEqual(expected.slice(3).map((id) => ({ id })));

      // Unbounded max: the tenure == 40 and recency == 20 contacts come in.
      const open = await b.store.workerScanSegmentEnrollment.listCellContactsPage({
        ...q,
        tenure: { minDays: 10, maxDays: null },
        recency: { minDays: 5, maxDays: null },
        afterId: null,
        limit: 100,
      });
      expect(open).toHaveLength(expected.length + 2);
    });
  });
}
