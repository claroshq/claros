/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-session.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiSessionQueries } from "../areas/api-session.js";

export function d1ApiSession(db: D1Db): ApiSessionQueries {
  void db;
  return notYetOnD1<ApiSessionQueries>("apiSession");
}
