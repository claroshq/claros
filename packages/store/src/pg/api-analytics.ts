/**
 * Postgres implementation of the queries used by packages/api/src/routes/analytics.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiAnalyticsQueries } from "../areas/api-analytics.js";

export function pgApiAnalytics(db: PgDb): ApiAnalyticsQueries {
  void db;
  return {};
}
