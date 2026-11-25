/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-products.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiProductsQueries } from "../areas/api-products.js";

export function d1ApiProducts(db: D1Db): ApiProductsQueries {
  void db;
  return notYetOnD1<ApiProductsQueries>("apiProducts");
}
