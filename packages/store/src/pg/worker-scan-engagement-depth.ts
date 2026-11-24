/**
 * Postgres implementation of the queries used by packages/worker/src/scan-engagement-depth.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerScanEngagementDepthQueries } from "../areas/worker-scan-engagement-depth.js";

export function pgWorkerScanEngagementDepth(db: PgDb): WorkerScanEngagementDepthQueries {
  void db;
  return {};
}
