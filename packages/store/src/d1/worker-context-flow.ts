/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-flow.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerContextFlowQueries } from "../areas/worker-context-flow.js";

export function d1WorkerContextFlow(db: D1Db): WorkerContextFlowQueries {
  void db;
  return notYetOnD1<WorkerContextFlowQueries>("workerContextFlow");
}
