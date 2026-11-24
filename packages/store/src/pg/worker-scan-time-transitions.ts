/**
 * Postgres implementation of the queries used by packages/worker/src/scan-time-transitions.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerScanTimeTransitionsQueries } from "../areas/worker-scan-time-transitions.js";

export function pgWorkerScanTimeTransitions(db: PgDb): WorkerScanTimeTransitionsQueries {
  void db;
  return {};
}
