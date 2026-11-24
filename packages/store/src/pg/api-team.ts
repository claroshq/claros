/**
 * Postgres implementation of the queries used by packages/api/src/routes/team.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiTeamQueries } from "../areas/api-team.js";

export function pgApiTeam(db: PgDb): ApiTeamQueries {
  void db;
  return {};
}
