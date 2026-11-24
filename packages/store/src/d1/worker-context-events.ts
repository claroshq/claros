/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-events.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerContextEventsQueries } from "../areas/worker-context-events.js";

export function d1WorkerContextEvents(db: D1Db): WorkerContextEventsQueries {
  void db;
  return notYetOnD1<WorkerContextEventsQueries>("workerContextEvents");
}
