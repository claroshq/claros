/**
 * Postgres implementation of the queries used by packages/api/src/routes/contacts.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiContactsQueries } from "../areas/api-contacts.js";

export function pgApiContacts(db: PgDb): ApiContactsQueries {
  void db;
  return {};
}
