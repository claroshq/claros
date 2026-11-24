/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-library.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiLibraryQueries } from "../areas/api-library.js";

export function d1ApiLibrary(db: D1Db): ApiLibraryQueries {
  void db;
  return notYetOnD1<ApiLibraryQueries>("apiLibrary");
}
