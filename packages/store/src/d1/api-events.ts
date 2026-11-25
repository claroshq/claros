/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-events.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiEventsQueries } from "../areas/api-events.js";

export function d1ApiEvents(db: D1Db): ApiEventsQueries {
  void db;
  return notYetOnD1<ApiEventsQueries>("apiEvents");
}
