/**
 * Postgres implementation of the queries used by packages/api/src/routes/kb.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiKbQueries } from "../areas/api-kb.js";

export function pgApiKb(db: PgDb): ApiKbQueries {
  void db;
  return {};
}
