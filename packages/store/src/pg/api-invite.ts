/**
 * Postgres implementation of the queries used by packages/api/src/routes/invite.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiInviteQueries } from "../areas/api-invite.js";

export function pgApiInvite(db: PgDb): ApiInviteQueries {
  void db;
  return {};
}
