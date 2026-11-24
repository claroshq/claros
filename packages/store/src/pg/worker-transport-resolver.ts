/**
 * Postgres implementation of the queries used by packages/worker/src/transport-resolver.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerTransportResolverQueries } from "../areas/worker-transport-resolver.js";

export function pgWorkerTransportResolver(db: PgDb): WorkerTransportResolverQueries {
  void db;
  return {};
}
