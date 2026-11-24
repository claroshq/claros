/**
 * Postgres implementation of the queries used by packages/worker/src/drain.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerDrainQueries } from "../areas/worker-drain.js";

export function pgWorkerDrain(db: PgDb): WorkerDrainQueries {
  void db;
  return {};
}
