/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-contact.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerContextContactQueries } from "../areas/worker-context-contact.js";

export function d1WorkerContextContact(db: D1Db): WorkerContextContactQueries {
  void db;
  return notYetOnD1<WorkerContextContactQueries>("workerContextContact");
}
