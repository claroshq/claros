/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-enroll.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerEnrollQueries } from "../areas/worker-enroll.js";

export function d1WorkerEnroll(db: D1Db): WorkerEnrollQueries {
  void db;
  return notYetOnD1<WorkerEnrollQueries>("workerEnroll");
}
