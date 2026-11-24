/**
 * Postgres implementation of the queries used by packages/worker/src/compile.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerCompileQueries } from "../areas/worker-compile.js";

export function pgWorkerCompile(db: PgDb): WorkerCompileQueries {
  void db;
  return {};
}
