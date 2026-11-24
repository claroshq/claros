/**
 * Postgres implementation of the queries used by packages/api/src/routes/unsubscribe.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiUnsubscribeQueries } from "../areas/api-unsubscribe.js";

export function pgApiUnsubscribe(db: PgDb): ApiUnsubscribeQueries {
  void db;
  return {};
}
