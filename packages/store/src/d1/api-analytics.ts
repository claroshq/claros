/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-analytics.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiAnalyticsQueries } from "../areas/api-analytics.js";

export function d1ApiAnalytics(db: D1Db): ApiAnalyticsQueries {
  void db;
  return notYetOnD1<ApiAnalyticsQueries>("apiAnalytics");
}
