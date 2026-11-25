/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-claim.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiClaimQueries } from "../areas/api-claim.js";

export function d1ApiClaim(db: D1Db): ApiClaimQueries {
  void db;
  return notYetOnD1<ApiClaimQueries>("apiClaim");
}
