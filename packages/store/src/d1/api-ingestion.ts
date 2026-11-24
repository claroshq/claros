/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingestion.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiIngestionQueries } from "../areas/api-ingestion.js";

export function d1ApiIngestion(db: D1Db): ApiIngestionQueries {
  void db;
  return notYetOnD1<ApiIngestionQueries>("apiIngestion");
}
