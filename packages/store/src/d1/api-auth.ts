/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-auth.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiAuthQueries } from "../areas/api-auth.js";

export function d1ApiAuth(db: D1Db): ApiAuthQueries {
  void db;
  return notYetOnD1<ApiAuthQueries>("apiAuth");
}
