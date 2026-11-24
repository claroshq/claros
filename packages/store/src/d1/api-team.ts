/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-team.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiTeamQueries } from "../areas/api-team.js";

export function d1ApiTeam(db: D1Db): ApiTeamQueries {
  void db;
  return notYetOnD1<ApiTeamQueries>("apiTeam");
}
