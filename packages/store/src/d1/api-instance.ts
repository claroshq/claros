/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-instance.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiInstanceQueries } from "../areas/api-instance.js";

export function d1ApiInstance(db: D1Db): ApiInstanceQueries {
  void db;
  return notYetOnD1<ApiInstanceQueries>("apiInstance");
}
