/**
 * Postgres implementation of the queries used by packages/worker/src/reap.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerReapQueries } from "../areas/worker-reap.js";

export function pgWorkerReap(db: PgDb): WorkerReapQueries {
  void db;
  return {};
}
