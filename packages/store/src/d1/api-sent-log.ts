/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-sent-log.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiSentLogQueries } from "../areas/api-sent-log.js";

export function d1ApiSentLog(db: D1Db): ApiSentLogQueries {
  void db;
  return notYetOnD1<ApiSentLogQueries>("apiSentLog");
}
