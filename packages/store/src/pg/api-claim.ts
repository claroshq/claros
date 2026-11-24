/**
 * Postgres implementation of the queries used by packages/api/src/routes/claim.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiClaimQueries } from "../areas/api-claim.js";

export function pgApiClaim(db: PgDb): ApiClaimQueries {
  void db;
  return {};
}
