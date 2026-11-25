/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-snapshot-retention-grid.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerSnapshotRetentionGridQueries } from "../areas/worker-snapshot-retention-grid.js";

export function d1WorkerSnapshotRetentionGrid(db: D1Db): WorkerSnapshotRetentionGridQueries {
  void db;
  return notYetOnD1<WorkerSnapshotRetentionGridQueries>("workerSnapshotRetentionGrid");
}
