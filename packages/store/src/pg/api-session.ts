/**
 * Postgres implementation of the queries used by packages/api/src/http/session.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiSessionQueries } from "../areas/api-session.js";

export function pgApiSession(db: PgDb): ApiSessionQueries {
  void db;
  return {};
}
