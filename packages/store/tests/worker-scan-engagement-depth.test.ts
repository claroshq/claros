/**
 * Contract tests for workerScanEngagementDepth.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, sortedIds } from "./support/worker-fixtures.js";

for (const factory of testBackends()) {
  describe(`workerScanEngagementDepth on ${factory.name}`, () => {
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
      const rows = await b.store.workerScanEngagementDepth.listTenants([t1, t2]);
      expect(rows).toEqual(sortedIds([t1, t2]).map((id) => ({ id, settings: null })));
      const all = await b.store.workerScanEngagementDepth.listTenants();
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([t1, t2]));
    });

    it("loadEngagedEventCounts returns counts, cohort size and percentile_cont cutoff", async () => {
      const t = await b.newTenant();
      const counts: Array<[number, number | null]> = [
        [1, 0],
        [0, 2],
        [2, 1],
        [4, null],
        [6, 4],
      ];
      const ids: Record<string, number> = {};
      for (const [cur, prev] of counts) {
        const id = await insertContact(b, t, {
          lifecycleState: "engaged",
          eventCountBucketCurrent: cur,
          eventCountBucketPrev: prev,
        });
        ids[id] = cur + (prev ?? 0);
      }
      await insertContact(b, t, { lifecycleState: "engaged", eventCountBucketCurrent: 0, eventCountBucketPrev: 0 });
      await insertContact(b, t, { lifecycleState: "activated", eventCountBucketCurrent: 50 });

      const rows = await b.store.workerScanEngagementDepth.loadEngagedEventCounts({
        tenantId: t,
        minCohort: 3,
        percentile: 0.8,
      });
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        // pg returns int4 sums as numbers and COUNT as a bigint string; callers use Number().
        expect(Number(r.event_count)).toBe(ids[r.contact_id]);
        expect(Number(r.cohort_size)).toBe(5);
        // sorted [1, 2, 3, 4, 10]: pos 3.2 -> 4 + 0.2 * 6
        expect(Number(r.power_cutoff)).toBeCloseTo(5.2, 10);
      }

      const small = await b.store.workerScanEngagementDepth.loadEngagedEventCounts({
        tenantId: t,
        minCohort: 6,
        percentile: 0.8,
      });
      expect(small).toHaveLength(5);
      for (const r of small) expect(r.power_cutoff).toBeNull();

      const empty = await b.store.workerScanEngagementDepth.loadEngagedEventCounts({
        tenantId: await b.newTenant(),
        minCohort: 1,
        percentile: 0.5,
      });
      expect(empty).toEqual([]);
    });

    it("writeEngagementDepths updates only engaged, changed rows of the tenant (over 100 params)", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const engaged: string[] = [];
      for (let i = 0; i < 60; i++) {
        engaged.push(
          await insertContact(b, t, { lifecycleState: "engaged", engagementDepth: i < 10 ? "power" : null }),
        );
      }
      const notEngaged = await insertContact(b, t, { lifecycleState: "dormant" });
      const foreign = await insertContact(b, other, { lifecycleState: "engaged" });

      const assignments: Array<[string, string]> = [
        ...engaged.map((id): [string, string] => [id, "power"]),
        [notEngaged, "casual"],
        [foreign, "casual"],
      ];
      const updated = await b.store.workerScanEngagementDepth.writeEngagementDepths({ tenantId: t, assignments });
      expect(updated).toBe(50);

      const rows = await b.db
        .select({ id: b.schema.contacts.id, depth: b.schema.contacts.engagementDepth })
        .from(b.schema.contacts)
        .where(inArray(b.schema.contacts.id, [...engaged, notEngaged, foreign]));
      for (const r of rows) {
        expect(r.depth).toBe(engaged.includes(r.id) ? "power" : null);
      }

      expect(
        await b.store.workerScanEngagementDepth.writeEngagementDepths({ tenantId: t, assignments }),
      ).toBe(0);

      const one = await b.store.workerScanEngagementDepth.writeEngagementDepths({
        tenantId: t,
        assignments: [[engaged[0]!, "casual"]],
      });
      expect(one).toBe(1);
      const [r0] = await b.db
        .select({ depth: b.schema.contacts.engagementDepth })
        .from(b.schema.contacts)
        .where(eq(b.schema.contacts.id, engaged[0]!));
      expect(r0.depth).toBe("casual");
    });
  });
}
