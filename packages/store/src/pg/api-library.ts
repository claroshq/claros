/**
 * Postgres implementation of the queries used by packages/api/src/routes/library.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiLibraryQueries } from "../areas/api-library.js";

export function pgApiLibrary(db: PgDb): ApiLibraryQueries {
  void db;
  return {};
}
