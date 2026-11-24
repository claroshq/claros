/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-enrollment.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerScanEnrollmentQueries } from "../areas/worker-scan-enrollment.js";

export function d1WorkerScanEnrollment(db: D1Db): WorkerScanEnrollmentQueries {
  void db;
  return notYetOnD1<WorkerScanEnrollmentQueries>("workerScanEnrollment");
}
