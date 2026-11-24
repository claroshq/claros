/**
 * Postgres implementation of the queries used by packages/worker/src/context-flow.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContextFlowQueries } from "../areas/worker-context-flow.js";

export function pgWorkerContextFlow(db: PgDb): WorkerContextFlowQueries {
  void db;
  return {};
}
