/**
 * Contract tests for workerSnapshotRetentionGrid.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, sortedIds } from "./support/worker-fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const key = (r: { tenure: string; recency: string }) => `${r.tenure}/${r.recency}`;

for (const factory of testBackends()) {
  describe(`workerSnapshotRetentionGrid on ${factory.name}`, () => {
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
      const rows = await b.store.workerSnapshotRetentionGrid.listTenants([t1, t2]);
      expect(rows.map((r) => r.id)).toEqual(sortedIds([t1, t2]));
      const all = await b.store.workerSnapshotRetentionGrid.listTenants();
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([t1, t2]));
    });

    it("countGridCells buckets contacts by tenure and recency", async () => {
      const t = await b.newTenant();
      const add = (first: number | null, last: number | null, paymentStatus = "free") =>
        insertContact(b, t, {
          firstSeenAt: first === null ? null : ago(first),
          lastSeenAt: last === null ? null : ago(last),
          paymentStatus,
        });
      await add(5, 1, "paid");
      await add(5, 2);
      await add(60, 10, "past_due");
      await add(120, 20, "trial");
      await add(400, 50, "paid");
      await add(null, null);
      await insertContact(b, await b.newTenant(), { firstSeenAt: ago(5), lastSeenAt: ago(1) });

      const rows = await b.store.workerSnapshotRetentionGrid.countGridCells({
        tenantId: t,
        recencyDays: { cooling: 7, idle: 14, dormant: 28 },
      });
      const sorted = [...rows].sort((x, y) => key(x).localeCompare(key(y)));
      expect(sorted).toEqual([
        { tenure: "established", recency: "idle", count: 1, paying: 0 },
        { tenure: "growing", recency: "cooling", count: 1, paying: 1 },
        { tenure: "loyal", recency: "dormant", count: 2, paying: 1 },
        { tenure: "new", recency: "active", count: 2, paying: 1 },
      ]);
    });

    it("upsertSnapshotRows inserts and overwrites a day's rows", async () => {
      const t = await b.newTenant();
      const tenures = ["new", "growing", "established", "loyal"];
      const recencies = ["active", "cooling", "idle", "dormant"];
      const rows = (base: number, day: string) =>
        tenures.flatMap((tenureBucket, i) =>
          recencies.map((recencyBucket, j) => ({
            tenantId: t,
            snapshotDate: day,
            tenureBucket,
            recencyBucket,
            contactCount: base + i * 4 + j,
            payingCount: i,
          })),
        );
      // 16 + 4 rows: more than one D1 statement.
      await b.store.workerSnapshotRetentionGrid.upsertSnapshotRows([
        ...rows(0, "2026-11-19"),
        ...rows(0, "2026-11-20").slice(0, 4),
      ]);
      await b.store.workerSnapshotRetentionGrid.upsertSnapshotRows(rows(100, "2026-11-20"));

      const read = async (day: string) =>
        b.db
          .select()
          .from(b.schema.retentionGridSnapshots)
          .where(
            and(
              eq(b.schema.retentionGridSnapshots.tenantId, t),
              eq(b.schema.retentionGridSnapshots.snapshotDate, day),
            ),
          );
      const d19 = await read("2026-11-19");
      const d20 = await read("2026-11-20");
      expect(d19).toHaveLength(16);
      expect(d20).toHaveLength(16);
      const sum = (xs: Array<{ contactCount: number }>) => xs.reduce((n, r) => n + r.contactCount, 0);
      expect(sum(d19)).toBe(120);
      expect(sum(d20)).toBe(1720);
      const cell = d20.find(
        (r: { tenureBucket: string; recencyBucket: string }) => r.tenureBucket === "loyal" && r.recencyBucket === "dormant",
      );
      expect(cell).toMatchObject({ contactCount: 115, payingCount: 3 });
    });
  });
}
