/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-drain.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerDrainQueries } from "../areas/worker-drain.js";

export function d1WorkerDrain(db: D1Db): WorkerDrainQueries {
  void db;
  return notYetOnD1<WorkerDrainQueries>("workerDrain");
}
