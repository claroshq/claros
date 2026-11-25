/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-settings.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiSettingsQueries } from "../areas/api-settings.js";

export function d1ApiSettings(db: D1Db): ApiSettingsQueries {
  void db;
  return notYetOnD1<ApiSettingsQueries>("apiSettings");
}
