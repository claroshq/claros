/**
 * Postgres implementation of the queries used by packages/worker/src/scan-enrollment.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerScanEnrollmentQueries } from "../areas/worker-scan-enrollment.js";

export function pgWorkerScanEnrollment(db: PgDb): WorkerScanEnrollmentQueries {
  void db;
  return {};
}
