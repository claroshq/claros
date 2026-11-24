/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-messages.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiMessagesQueries } from "../areas/api-messages.js";

export function d1ApiMessages(db: D1Db): ApiMessagesQueries {
  void db;
  return notYetOnD1<ApiMessagesQueries>("apiMessages");
}
