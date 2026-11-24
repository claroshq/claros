/**
 * Postgres implementation of the queries used by packages/api/src/routes/ingestion.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiIngestionQueries } from "../areas/api-ingestion.js";

export function pgApiIngestion(db: PgDb): ApiIngestionQueries {
  void db;
  return {};
}
