/**
 * Postgres implementation of the queries used by packages/api/src/routes/templates.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiTemplatesQueries } from "../areas/api-templates.js";

export function pgApiTemplates(db: PgDb): ApiTemplatesQueries {
  void db;
  return {};
}
