/**
 * Postgres implementation of the queries used by packages/api/src/routes/ingest.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiIngestQueries } from "../areas/api-ingest.js";

export function pgApiIngest(db: PgDb): ApiIngestQueries {
  void db;
  return {};
}
