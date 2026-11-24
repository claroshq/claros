/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-counter-rollover.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerCounterRolloverQueries } from "../areas/worker-counter-rollover.js";

export function d1WorkerCounterRollover(db: D1Db): WorkerCounterRolloverQueries {
  void db;
  return notYetOnD1<WorkerCounterRolloverQueries>("workerCounterRollover");
}
