/**
 * Postgres implementation of the queries used by packages/worker/src/content.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContentQueries } from "../areas/worker-content.js";

export function pgWorkerContent(db: PgDb): WorkerContentQueries {
  void db;
  return {};
}
