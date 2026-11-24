/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-kb.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiKbQueries } from "../areas/api-kb.js";

export function d1ApiKb(db: D1Db): ApiKbQueries {
  void db;
  return notYetOnD1<ApiKbQueries>("apiKb");
}
