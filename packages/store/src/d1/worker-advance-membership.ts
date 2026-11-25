/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-advance-membership.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerAdvanceMembershipQueries } from "../areas/worker-advance-membership.js";

export function d1WorkerAdvanceMembership(db: D1Db): WorkerAdvanceMembershipQueries {
  void db;
  return notYetOnD1<WorkerAdvanceMembershipQueries>("workerAdvanceMembership");
}
