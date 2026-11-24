/**
 * Postgres implementation of the queries used by packages/api/src/routes/events.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiEventsQueries } from "../areas/api-events.js";

export function pgApiEvents(db: PgDb): ApiEventsQueries {
  void db;
  return {};
}
