/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-segment-enrollment.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerScanSegmentEnrollmentQueries } from "../areas/worker-scan-segment-enrollment.js";

export function d1WorkerScanSegmentEnrollment(db: D1Db): WorkerScanSegmentEnrollmentQueries {
  void db;
  return notYetOnD1<WorkerScanSegmentEnrollmentQueries>("workerScanSegmentEnrollment");
}
