/**
 * Postgres implementation of the queries used by packages/api/src/routes/email-templates.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiEmailTemplatesQueries } from "../areas/api-email-templates.js";

export function pgApiEmailTemplates(db: PgDb): ApiEmailTemplatesQueries {
  void db;
  return {};
}
