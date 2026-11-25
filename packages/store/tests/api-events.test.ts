/**
 * Contract tests for apiEvents (packages/api/src/routes/events.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { sixMonthsBefore } from "../src/d1/api-events.js";

for (const factory of testBackends()) {
  describe(`apiEvents on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function seed(tenantId: string, list: Array<{ type?: string; name: string | null; receivedAt?: Date }>) {
      const [contact] = await b.db
        .insert(b.schema.contacts)
        .values({ tenantId, externalId: "u1", lifecycleState: "signed_up" })
        .returning({ id: b.schema.contacts.id });
      const rows = list.map((e) => ({
          tenantId,
          contactId: contact.id,
          type: e.type ?? "track",
          eventName: e.name,
          timestamp: new Date(),
          ...(e.receivedAt ? { receivedAt: e.receivedAt } : {}),
      }));
      // D1 allows at most 100 bound parameters per statement.
      for (let i = 0; i < rows.length; i += 10) {
        await b.db.insert(b.schema.events).values(rows.slice(i, i + 10));
      }
    }

    it("lists track event names by frequency, then name, without identify or null names", async () => {
      const t = await b.newTenant();
      await seed(t, [
        { name: "b_two" }, { name: "b_two" },
        { name: "a_two" }, { name: "a_two" },
        { name: "c_three" }, { name: "c_three" }, { name: "c_three" },
        { name: "d_one" },
        { name: null },
        { type: "identify", name: "identify_name" }, { type: "identify", name: "identify_name" },
        { type: "identify", name: "identify_name" }, { type: "identify", name: "identify_name" },
      ]);
      const other = await b.newTenant();
      await seed(other, [{ name: "other_tenant" }]);
      expect(await b.store.apiEvents.listRecentTrackEventNames(t)).toEqual(["c_three", "a_two", "b_two", "d_one"]);
    });

    it("returns at most 200 names", async () => {
      const t = await b.newTenant();
      await seed(t, Array.from({ length: 205 }, (_, i) => ({ name: `e${String(i).padStart(3, "0")}` })));
      const names = await b.store.apiEvents.listRecentTrackEventNames(t);
      expect(names).toHaveLength(200);
      expect(names[0]).toBe("e000");
      expect(names[199]).toBe("e199");
    });

    it("returns an empty list for a tenant without events", async () => {
      expect(await b.store.apiEvents.listRecentTrackEventNames(await b.newTenant())).toEqual([]);
    });

    if (factory.name === "d1") {
      // The local Postgres has no events partition older than six months, so
      // the cutoff itself is checked on D1 here and against Postgres' interval
      // arithmetic in the pg block below.
      it("ignores events received more than six months ago", async () => {
        const t = await b.newTenant();
        const now = new Date();
        await seed(t, [
          { name: "old", receivedAt: new Date(sixMonthsBefore(now).getTime() - 60_000) },
          { name: "old", receivedAt: new Date(sixMonthsBefore(now).getTime() - 60_000) },
          { name: "recent", receivedAt: new Date(sixMonthsBefore(now).getTime() + 60_000) },
        ]);
        expect(await b.store.apiEvents.listRecentTrackEventNames(t)).toEqual(["recent"]);
      });
    }

    if (factory.name === "pg") {
      it("computes the six-month cutoff like Postgres interval arithmetic", async () => {
        const samples = [
          "2026-11-25T10:11:12.345Z",
          "2026-08-31T23:59:59.999Z",
          "2026-03-31T00:00:00.000Z",
          "2026-05-31T12:00:00.000Z",
          "2028-08-30T05:00:00.000Z",
          "2026-01-15T00:00:00.000Z",
        ];
        for (const s of samples) {
          const res = await b.db.execute(
            sql`SELECT (${s}::timestamptz AT TIME ZONE 'UTC' - interval '6 months') AT TIME ZONE 'UTC' AS cutoff`,
          );
          expect(sixMonthsBefore(new Date(s))).toEqual(new Date(res.rows[0].cutoff));
        }
      });
    }
  });
}
