/**
 * Postgres implementation of the queries used by packages/worker/src/context-contact.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContextContactQueries } from "../areas/worker-context-contact.js";

export function pgWorkerContextContact(db: PgDb): WorkerContextContactQueries {
  void db;
  return {};
}
