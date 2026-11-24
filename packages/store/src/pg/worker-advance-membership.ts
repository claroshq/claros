/**
 * Postgres implementation of the queries used by packages/worker/src/advance-membership.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerAdvanceMembershipQueries } from "../areas/worker-advance-membership.js";

export function pgWorkerAdvanceMembership(db: PgDb): WorkerAdvanceMembershipQueries {
  void db;
  return {};
}
