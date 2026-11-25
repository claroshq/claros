/**
 * Contract tests for the workerCounterRollover store area (packages/worker/src/counter-rollover.ts).
 *
 * rollEngagementCounters is global (no tenant scope), so on the shared Postgres the
 * returned count includes other suites' contacts: assert a lower bound and per-row effects.
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { seedContact } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

for (const factory of testBackends()) {
  describe(`workerCounterRollover on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const contact = async (id: string) =>
      (await b.db.select().from(b.schema.contacts).where(eq(b.schema.contacts.id, id)))[0];

    it("rolls current into prev for contacts never reset or reset more than 15 days ago", async () => {
      const t = await b.newTenant();
      const never = await seedContact(b, t, { eventCountBucketCurrent: 7, eventCountBucketPrev: 3, lastCounterResetAt: null });
      const old = await seedContact(b, t, { eventCountBucketCurrent: 5, eventCountBucketPrev: 1, lastCounterResetAt: new Date(NOW.getTime() - 15 * DAY - 1) });
      const exactly15 = await seedContact(b, t, { eventCountBucketCurrent: 4, eventCountBucketPrev: 2, lastCounterResetAt: new Date(NOW.getTime() - 15 * DAY) });
      const recent = await seedContact(b, t, { eventCountBucketCurrent: 9, eventCountBucketPrev: 8, lastCounterResetAt: new Date(NOW.getTime() - DAY) });

      const n = await b.store.workerCounterRollover.rollEngagementCounters(NOW);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(await contact(never)).toMatchObject({ eventCountBucketCurrent: 0, eventCountBucketPrev: 7, lastCounterResetAt: NOW });
      expect(await contact(old)).toMatchObject({ eventCountBucketCurrent: 0, eventCountBucketPrev: 5, lastCounterResetAt: NOW });
      expect(await contact(exactly15)).toMatchObject({ eventCountBucketCurrent: 4, eventCountBucketPrev: 2 });
      expect(await contact(recent)).toMatchObject({ eventCountBucketCurrent: 9, eventCountBucketPrev: 8 });

      // Everything was just reset at NOW: a second run with the same now updates none of ours.
      await b.store.workerCounterRollover.rollEngagementCounters(NOW);
      expect(await contact(never)).toMatchObject({ eventCountBucketCurrent: 0, eventCountBucketPrev: 7 });
    });

    it("returns the number of rows updated", async () => {
      if (b.name === "pg") return; // shared database: the exact count depends on other suites
      await b.store.workerCounterRollover.rollEngagementCounters(NOW);
      const t = await b.newTenant();
      await seedContact(b, t);
      await seedContact(b, t);
      expect(await b.store.workerCounterRollover.rollEngagementCounters(NOW)).toBe(2);
      expect(await b.store.workerCounterRollover.rollEngagementCounters(NOW)).toBe(0);
    });
  });
}
