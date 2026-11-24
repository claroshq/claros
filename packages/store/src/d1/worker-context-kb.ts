/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-kb.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerContextKbQueries } from "../areas/worker-context-kb.js";

export function d1WorkerContextKb(db: D1Db): WorkerContextKbQueries {
  void db;
  return notYetOnD1<WorkerContextKbQueries>("workerContextKb");
}
