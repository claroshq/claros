/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-embed-kb.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerEmbedKbQueries } from "../areas/worker-embed-kb.js";

export function d1WorkerEmbedKb(db: D1Db): WorkerEmbedKbQueries {
  void db;
  return notYetOnD1<WorkerEmbedKbQueries>("workerEmbedKb");
}
