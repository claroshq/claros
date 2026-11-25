/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-time-transitions.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerScanTimeTransitionsQueries } from "../areas/worker-scan-time-transitions.js";

export function d1WorkerScanTimeTransitions(db: D1Db): WorkerScanTimeTransitionsQueries {
  void db;
  return notYetOnD1<WorkerScanTimeTransitionsQueries>("workerScanTimeTransitions");
}
