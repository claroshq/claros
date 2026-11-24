/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-step-advancement.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerScanStepAdvancementQueries } from "../areas/worker-scan-step-advancement.js";

export function d1WorkerScanStepAdvancement(db: D1Db): WorkerScanStepAdvancementQueries {
  void db;
  return notYetOnD1<WorkerScanStepAdvancementQueries>("workerScanStepAdvancement");
}
