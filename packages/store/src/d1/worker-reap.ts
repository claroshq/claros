/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-reap.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerReapQueries } from "../areas/worker-reap.js";

export function d1WorkerReap(db: D1Db): WorkerReapQueries {
  void db;
  return notYetOnD1<WorkerReapQueries>("workerReap");
}
