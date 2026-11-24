/**
 * Postgres implementation of the queries used by packages/worker/src/scan-segment-enrollment.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerScanSegmentEnrollmentQueries } from "../areas/worker-scan-segment-enrollment.js";

export function pgWorkerScanSegmentEnrollment(db: PgDb): WorkerScanSegmentEnrollmentQueries {
  void db;
  return {};
}
