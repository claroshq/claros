/**
 * Postgres implementation of the queries used by packages/api/src/http/ingest-auth.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiIngestAuthQueries } from "../areas/api-ingest-auth.js";

export function pgApiIngestAuth(db: PgDb): ApiIngestAuthQueries {
  void db;
  return {};
}
