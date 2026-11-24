/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-profile.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiProfileQueries } from "../areas/api-profile.js";

export function d1ApiProfile(db: D1Db): ApiProfileQueries {
  void db;
  return notYetOnD1<ApiProfileQueries>("apiProfile");
}
