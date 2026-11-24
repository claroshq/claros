/**
 * Postgres implementation of the queries used by packages/worker/src/provider-resolver.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerProviderResolverQueries } from "../areas/worker-provider-resolver.js";

export function pgWorkerProviderResolver(db: PgDb): WorkerProviderResolverQueries {
  void db;
  return {};
}
