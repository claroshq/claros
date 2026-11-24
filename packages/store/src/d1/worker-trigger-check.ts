/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-trigger-check.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerTriggerCheckQueries } from "../areas/worker-trigger-check.js";

export function d1WorkerTriggerCheck(db: D1Db): WorkerTriggerCheckQueries {
  void db;
  return notYetOnD1<WorkerTriggerCheckQueries>("workerTriggerCheck");
}
