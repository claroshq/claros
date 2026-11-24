/**
 * Postgres implementation of the queries used by packages/worker/src/snapshot-retention-grid.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerSnapshotRetentionGridQueries } from "../areas/worker-snapshot-retention-grid.js";

export function pgWorkerSnapshotRetentionGrid(db: PgDb): WorkerSnapshotRetentionGridQueries {
  void db;
  return {};
}
