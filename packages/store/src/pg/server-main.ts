/**
 * Postgres implementation of the queries used by apps/server/src/main.ts.
 */
import type { PgDb } from "./db.js";
import type { ServerMainQueries } from "../areas/server-main.js";

export function pgServerMain(db: PgDb): ServerMainQueries {
  void db;
  return {};
}
