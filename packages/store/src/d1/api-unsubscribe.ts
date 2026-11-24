/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-unsubscribe.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiUnsubscribeQueries } from "../areas/api-unsubscribe.js";

export function d1ApiUnsubscribe(db: D1Db): ApiUnsubscribeQueries {
  void db;
  return notYetOnD1<ApiUnsubscribeQueries>("apiUnsubscribe");
}
