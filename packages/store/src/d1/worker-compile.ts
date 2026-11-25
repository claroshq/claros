/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-compile.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { WorkerCompileQueries } from "../areas/worker-compile.js";

export function d1WorkerCompile(db: D1Db): WorkerCompileQueries {
  void db;
  return notYetOnD1<WorkerCompileQueries>("workerCompile");
}
