/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-partition-maintenance.ts.
 *
 * SQLite has no table partitions: `events` is one plain table. Every monthly
 * partition is reported as already existing, so the maintenance job has
 * nothing to do, and creating one is a no-op.
 */
import type { D1Db } from "./db.js";
import type { WorkerPartitionMaintenanceQueries } from "../areas/worker-partition-maintenance.js";

export function d1WorkerPartitionMaintenance(db: D1Db): WorkerPartitionMaintenanceQueries {
  void db;
  return {
    async partitionExists() {
      return true;
    },
    async createEventsPartition() {
      // No partitions on SQLite.
    },
  };
}
