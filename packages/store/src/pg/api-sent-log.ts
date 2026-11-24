/**
 * Postgres implementation of the queries used by packages/api/src/routes/sent-log.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiSentLogQueries } from "../areas/api-sent-log.js";

export function pgApiSentLog(db: PgDb): ApiSentLogQueries {
  void db;
  return {};
}
