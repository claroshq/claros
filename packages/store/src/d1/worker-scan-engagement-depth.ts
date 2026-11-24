/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-engagement-depth.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerScanEngagementDepthQueries } from "../areas/worker-scan-engagement-depth.js";

export function d1WorkerScanEngagementDepth(db: D1Db): WorkerScanEngagementDepthQueries {
  void db;
  return notYetOnD1<WorkerScanEngagementDepthQueries>("workerScanEngagementDepth");
}
