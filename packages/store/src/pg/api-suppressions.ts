/**
 * Postgres implementation of the queries used by packages/api/src/routes/suppressions.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiSuppressionsQueries } from "../areas/api-suppressions.js";

export function pgApiSuppressions(db: PgDb): ApiSuppressionsQueries {
  void db;
  return {};
}
