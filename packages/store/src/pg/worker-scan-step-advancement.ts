/**
 * Postgres implementation of the queries used by packages/worker/src/scan-step-advancement.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerScanStepAdvancementQueries } from "../areas/worker-scan-step-advancement.js";

export function pgWorkerScanStepAdvancement(db: PgDb): WorkerScanStepAdvancementQueries {
  void db;
  return {};
}
