/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-drain-message.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerDrainMessageQueries } from "../areas/worker-drain-message.js";

export function d1WorkerDrainMessage(db: D1Db): WorkerDrainMessageQueries {
  void db;
  return notYetOnD1<WorkerDrainMessageQueries>("workerDrainMessage");
}
