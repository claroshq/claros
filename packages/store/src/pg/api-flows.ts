/**
 * Postgres implementation of the queries used by packages/api/src/routes/flows.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiFlowsQueries } from "../areas/api-flows.js";

export function pgApiFlows(db: PgDb): ApiFlowsQueries {
  void db;
  return {};
}
