/**
 * Postgres implementation of the queries used by packages/worker/src/embedding-client.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerEmbeddingClientQueries } from "../areas/worker-embedding-client.js";

export function pgWorkerEmbeddingClient(db: PgDb): WorkerEmbeddingClientQueries {
  void db;
  return {};
}
