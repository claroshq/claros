/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-partition-maintenance.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerPartitionMaintenanceQueries } from "../areas/worker-partition-maintenance.js";

export function d1WorkerPartitionMaintenance(db: D1Db): WorkerPartitionMaintenanceQueries {
  void db;
  return notYetOnD1<WorkerPartitionMaintenanceQueries>("workerPartitionMaintenance");
}
