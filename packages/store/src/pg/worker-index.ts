/**
 * Postgres implementation of the queries used by packages/worker/src/index.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerIndexQueries } from "../areas/worker-index.js";

export function pgWorkerIndex(db: PgDb): WorkerIndexQueries {
  void db;
  return {};
}
