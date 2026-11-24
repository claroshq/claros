/**
 * Postgres implementation of the queries used by packages/api/src/routes/profile.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiProfileQueries } from "../areas/api-profile.js";

export function pgApiProfile(db: PgDb): ApiProfileQueries {
  void db;
  return {};
}
