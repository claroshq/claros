/**
 * Postgres implementation of the queries used by packages/worker/src/trigger-check.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerTriggerCheckQueries } from "../areas/worker-trigger-check.js";

export function pgWorkerTriggerCheck(db: PgDb): WorkerTriggerCheckQueries {
  void db;
  return {};
}
