/**
 * Contract tests for workerContextEvents.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertEvent } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(now.getTime() - days * DAY);

for (const factory of testBackends()) {
  describe(`workerContextEvents on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function setup() {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const ev = (name: string | null, days: number, receivedDays = days) =>
        insertEvent(b, {
          tenantId: t,
          contactId: c,
          eventName: name,
          type: name === null ? "identify" : "track",
          timestamp: ago(days),
          receivedAt: ago(receivedDays),
        });
      await ev("a", 1);
      await ev("a", 2);
      await ev("b", 3);
      await ev(null, 3);
      await ev("c", 3);
      await ev("a", 8);
      await ev("b", 10);
      await ev("b", 13);
      await ev("old", 15);
      await ev("late", 9, 20); // received before receivedFrom
      await insertEvent(b, { tenantId: t, contactId: await insertContact(b, t), eventName: "a", timestamp: ago(1) });
      return { t, c };
    }

    it("countCadenceWindows counts the two 7-day windows", async () => {
      const { t, c } = await setup();
      const r = await b.store.workerContextEvents.countCadenceWindows({
        tenantId: t,
        contactId: c,
        now,
        w7Start: ago(7),
        w14Start: ago(14),
        receivedFrom: ago(16),
      });
      expect(r).toEqual({ current_7d: "5", previous_7d: "3" });
    });

    it("listRecentEvents orders by timestamp DESC, event_name ASC (nulls last)", async () => {
      const { t, c } = await setup();
      const rows = await b.store.workerContextEvents.listRecentEvents({
        tenantId: t,
        contactId: c,
        receivedFrom: ago(16),
        limit: 6,
      });
      expect(rows.map((r) => ({ event_name: r.event_name, timestamp: new Date(r.timestamp) }))).toEqual([
        { event_name: "a", timestamp: ago(1) },
        { event_name: "a", timestamp: ago(2) },
        { event_name: "b", timestamp: ago(3) },
        { event_name: "c", timestamp: ago(3) },
        { event_name: null, timestamp: ago(3) },
        { event_name: "a", timestamp: ago(8) },
      ]);
    });

    it("listMostUsedEventNames counts non-null names in the window", async () => {
      const { t, c } = await setup();
      const rows = await b.store.workerContextEvents.listMostUsedEventNames({
        tenantId: t,
        contactId: c,
        now,
        since: ago(14),
        receivedFrom: ago(16),
        limit: 3,
      });
      expect(rows).toEqual([
        { event_name: "a", cnt: "3" },
        { event_name: "b", cnt: "3" },
        { event_name: "c", cnt: "1" },
      ]);
    });
  });
}
