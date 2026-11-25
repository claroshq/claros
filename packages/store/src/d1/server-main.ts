/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/server-main.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ServerMainQueries } from "../areas/server-main.js";

export function d1ServerMain(db: D1Db): ServerMainQueries {
  void db;
  return notYetOnD1<ServerMainQueries>("serverMain");
}
