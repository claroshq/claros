/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-flows.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiFlowsQueries } from "../areas/api-flows.js";

export function d1ApiFlows(db: D1Db): ApiFlowsQueries {
  void db;
  return notYetOnD1<ApiFlowsQueries>("apiFlows");
}
