/**
 * Postgres implementation of the queries used by packages/api/src/routes/messages.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiMessagesQueries } from "../areas/api-messages.js";

export function pgApiMessages(db: PgDb): ApiMessagesQueries {
  void db;
  return {};
}
