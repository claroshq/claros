/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingest-auth.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiIngestAuthQueries } from "../areas/api-ingest-auth.js";

export function d1ApiIngestAuth(db: D1Db): ApiIngestAuthQueries {
  void db;
  return notYetOnD1<ApiIngestAuthQueries>("apiIngestAuth");
}
