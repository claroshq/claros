/**
 * Postgres implementation of the queries used by packages/worker/src/embed-kb.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerEmbedKbQueries } from "../areas/worker-embed-kb.js";

export function pgWorkerEmbedKb(db: PgDb): WorkerEmbedKbQueries {
  void db;
  return {};
}
