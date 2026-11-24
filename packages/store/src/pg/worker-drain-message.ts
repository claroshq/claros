/**
 * Postgres implementation of the queries used by packages/worker/src/drain-message.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerDrainMessageQueries } from "../areas/worker-drain-message.js";

export function pgWorkerDrainMessage(db: PgDb): WorkerDrainMessageQueries {
  void db;
  return {};
}
