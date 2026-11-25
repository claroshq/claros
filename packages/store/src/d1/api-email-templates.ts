/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-email-templates.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiEmailTemplatesQueries } from "../areas/api-email-templates.js";

export function d1ApiEmailTemplates(db: D1Db): ApiEmailTemplatesQueries {
  void db;
  return notYetOnD1<ApiEmailTemplatesQueries>("apiEmailTemplates");
}
