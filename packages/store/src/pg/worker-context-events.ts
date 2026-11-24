/**
 * Postgres implementation of the queries used by packages/worker/src/context-events.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContextEventsQueries } from "../areas/worker-context-events.js";

export function pgWorkerContextEvents(db: PgDb): WorkerContextEventsQueries {
  void db;
  return {};
}
