/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-process-message.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerProcessMessageQueries } from "../areas/worker-process-message.js";

export function d1WorkerProcessMessage(db: D1Db): WorkerProcessMessageQueries {
  void db;
  return notYetOnD1<WorkerProcessMessageQueries>("workerProcessMessage");
}
