/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-index.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerIndexQueries } from "../areas/worker-index.js";

export function d1WorkerIndex(db: D1Db): WorkerIndexQueries {
  void db;
  return notYetOnD1<WorkerIndexQueries>("workerIndex");
}
