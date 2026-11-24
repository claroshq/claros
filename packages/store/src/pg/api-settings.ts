/**
 * Postgres implementation of the queries used by packages/api/src/routes/settings.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiSettingsQueries } from "../areas/api-settings.js";

export function pgApiSettings(db: PgDb): ApiSettingsQueries {
  void db;
  return {};
}
