/**
 * Postgres implementation of the queries used by packages/worker/src/counter-rollover.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerCounterRolloverQueries } from "../areas/worker-counter-rollover.js";

export function pgWorkerCounterRollover(db: PgDb): WorkerCounterRolloverQueries {
  void db;
  return {};
}
