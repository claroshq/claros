/**
 * Postgres implementation of the queries used by packages/worker/src/context-kb.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContextKbQueries } from "../areas/worker-context-kb.js";

export function pgWorkerContextKb(db: PgDb): WorkerContextKbQueries {
  void db;
  return {};
}
