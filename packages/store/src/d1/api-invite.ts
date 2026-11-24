/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-invite.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiInviteQueries } from "../areas/api-invite.js";

export function d1ApiInvite(db: D1Db): ApiInviteQueries {
  void db;
  return notYetOnD1<ApiInviteQueries>("apiInvite");
}
