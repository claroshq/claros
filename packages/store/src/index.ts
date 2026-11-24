/**
 * @claros/store - every database query Claros runs, behind one interface per
 * calling module, with a Postgres implementation (and, from v0.8, a SQLite /
 * Cloudflare D1 implementation). See docs/dev/storage.md.
 *
 * Call sites keep receiving the Drizzle handle they always had and resolve
 * the matching Store with storeFor(db). A runtime registers the Store for its
 * handle once at startup; an unregistered handle is treated as Postgres,
 * which keeps tests that build their own node-postgres handle working.
 */
import type { Store } from "./types.js";
import { createPgStore } from "./pg/index.js";
import type { PgDb } from "./pg/db.js";

export type { Store } from "./types.js";
export * from "./types.js";
export { createPgStore } from "./pg/index.js";
export type { PgDb } from "./pg/db.js";

const stores = new WeakMap<object, Store>();

/** Bind a Store to a database handle (call once at startup). */
export function registerStore(db: object, store: Store): void {
  stores.set(db, store);
}

/** The Store for a database handle. Unregistered handles get a Postgres Store. */
export function storeFor(db: object): Store {
  let store = stores.get(db);
  if (!store) {
    store = createPgStore(db as PgDb);
    stores.set(db, store);
  }
  return store;
}
