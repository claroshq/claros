/**
 * Postgres implementation of the queries used by packages/worker/src/enroll.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerEnrollQueries } from "../areas/worker-enroll.js";

export function pgWorkerEnroll(db: PgDb): WorkerEnrollQueries {
  void db;
  return {};
}
