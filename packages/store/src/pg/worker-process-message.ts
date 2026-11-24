/**
 * Postgres implementation of the queries used by packages/worker/src/process-message.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerProcessMessageQueries } from "../areas/worker-process-message.js";

export function pgWorkerProcessMessage(db: PgDb): WorkerProcessMessageQueries {
  void db;
  return {};
}
