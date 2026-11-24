/**
 * Postgres implementation of the queries used by packages/worker/src/context-assembler.ts.
 */
import type { PgDb } from "./db.js";
import type { WorkerContextAssemblerQueries } from "../areas/worker-context-assembler.js";

export function pgWorkerContextAssembler(db: PgDb): WorkerContextAssemblerQueries {
  void db;
  return {};
}
