/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-suppressions.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiSuppressionsQueries } from "../areas/api-suppressions.js";

export function d1ApiSuppressions(db: D1Db): ApiSuppressionsQueries {
  void db;
  return notYetOnD1<ApiSuppressionsQueries>("apiSuppressions");
}
