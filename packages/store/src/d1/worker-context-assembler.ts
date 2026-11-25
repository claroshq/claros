/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-assembler.ts
 * (the module runs no queries of its own).
 */
import type { D1Db } from "./db.js";
import type { WorkerContextAssemblerQueries } from "../areas/worker-context-assembler.js";

export function d1WorkerContextAssembler(db: D1Db): WorkerContextAssemblerQueries {
  void db;
  return {};
}
