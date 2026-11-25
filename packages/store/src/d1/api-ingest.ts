/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingest.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiIngestQueries } from "../areas/api-ingest.js";

export function d1ApiIngest(db: D1Db): ApiIngestQueries {
  void db;
  return notYetOnD1<ApiIngestQueries>("apiIngest");
}
