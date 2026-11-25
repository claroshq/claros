/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-transport-resolver.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerTransportResolverQueries } from "../areas/worker-transport-resolver.js";

export function d1WorkerTransportResolver(db: D1Db): WorkerTransportResolverQueries {
  void db;
  return notYetOnD1<WorkerTransportResolverQueries>("workerTransportResolver");
}
