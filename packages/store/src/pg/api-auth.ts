/**
 * Postgres implementation of the queries used by packages/api/src/routes/auth.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiAuthQueries } from "../areas/api-auth.js";

export function pgApiAuth(db: PgDb): ApiAuthQueries {
  void db;
  return {};
}
