/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-content.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerContentQueries } from "../areas/worker-content.js";

export function d1WorkerContent(db: D1Db): WorkerContentQueries {
  void db;
  return notYetOnD1<WorkerContentQueries>("workerContent");
}
