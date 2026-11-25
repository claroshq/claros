/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-provider-resolver.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerProviderResolverQueries } from "../areas/worker-provider-resolver.js";

export function d1WorkerProviderResolver(db: D1Db): WorkerProviderResolverQueries {
  void db;
  return notYetOnD1<WorkerProviderResolverQueries>("workerProviderResolver");
}
