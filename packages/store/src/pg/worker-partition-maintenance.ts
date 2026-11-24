/**
 * Postgres implementation of the queries used by packages/worker/src/partition-maintenance.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerPartitionMaintenanceQueries } from "../areas/worker-partition-maintenance.js";

export function pgWorkerPartitionMaintenance(db: PgDb): WorkerPartitionMaintenanceQueries {
  void db;
  return {};
}
