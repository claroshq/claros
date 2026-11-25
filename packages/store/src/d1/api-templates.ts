/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-templates.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiTemplatesQueries } from "../areas/api-templates.js";

export function d1ApiTemplates(db: D1Db): ApiTemplatesQueries {
  void db;
  return notYetOnD1<ApiTemplatesQueries>("apiTemplates");
}
