/**
 * Contract tests for workerPartitionMaintenance. Partitions exist only on
 * Postgres; on D1 every partition reports as existing and creation is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`workerPartitionMaintenance on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("an existing monthly partition is reported and re-creating it is a no-op", async () => {
      const q = b.store.workerPartitionMaintenance;
      // events_y2026m11 exists on Postgres (created by migrations/maintenance);
      // on D1 there are no partitions and the job has nothing to do.
      expect(await q.partitionExists("events_y2026m11")).toBe(true);
      await expect(
        q.createEventsPartition({ name: "events_y2026m11", start: "2026-11-01", end: "2026-12-01" }),
      ).resolves.toBeUndefined();
      expect(await q.partitionExists("events_y2026m11")).toBe(true);
    });

    it("on D1 every partition is reported as existing", async () => {
      if (b.name !== "d1") return;
      expect(await b.store.workerPartitionMaintenance.partitionExists("events_y2099m01")).toBe(true);
    });
  });
}
