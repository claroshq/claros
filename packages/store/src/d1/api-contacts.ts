/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-contacts.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiContactsQueries } from "../areas/api-contacts.js";

export function d1ApiContacts(db: D1Db): ApiContactsQueries {
  void db;
  return notYetOnD1<ApiContactsQueries>("apiContacts");
}
