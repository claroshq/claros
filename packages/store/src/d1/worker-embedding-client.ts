/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-embedding-client.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerEmbeddingClientQueries } from "../areas/worker-embedding-client.js";

export function d1WorkerEmbeddingClient(db: D1Db): WorkerEmbeddingClientQueries {
  void db;
  return notYetOnD1<WorkerEmbeddingClientQueries>("workerEmbeddingClient");
}
