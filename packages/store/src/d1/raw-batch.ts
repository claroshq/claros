/**
 * Raw SQL batch on D1 (one SQLite transaction, all or nothing).
 *
 * Drizzle 0.45 cannot put raw `sql` statements inside `db.batch()` on D1
 * (SQLiteRaw has no prepared statement), so this goes to the binding behind
 * the Drizzle handle. Returns each statement's rows (timestamps as integer ms).
 */
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { D1Db } from "./db.js";

const dialect = new SQLiteAsyncDialect();

/** The D1 binding behind the Drizzle handle (the parts used here). */
interface D1Binding {
  prepare(query: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<Array<{ results?: unknown[] }>>;
}

export async function rawBatch(db: D1Db, queries: SQL[]): Promise<Array<Array<Record<string, unknown>>>> {
  const client = (db as unknown as { $client: D1Binding }).$client;
  const statements = queries.map((q) => {
    const { sql: text, params } = dialect.sqlToQuery(q);
    return client.prepare(text).bind(...params);
  });
  const results = await client.batch(statements);
  return results.map((r) => (r.results ?? []) as Array<Record<string, unknown>>);
}
