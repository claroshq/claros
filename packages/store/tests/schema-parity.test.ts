/**
 * The Postgres schema (drizzle/schema) and its SQLite / D1 twin
 * (drizzle/schema-sqlite) must describe the same tables, columns and named
 * indexes. A schema change that touches one side only fails here.
 */
import { describe, it, expect } from "vitest";
import { getTableConfig as pgConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as pg from "../../../drizzle/schema/index.js";
import * as sqlite from "../../../drizzle/schema-sqlite/index.js";

/** Index names that exist on one side only, by design. */
const PG_ONLY_INDEXES = new Set(["idx_kb_embedding"]); // pgvector IVFFlat; D1 uses FTS5

function describePg() {
  const out: Record<string, { columns: string[]; indexes: string[] }> = {};
  for (const t of Object.values(pg)) {
    if (!(t instanceof PgTable)) continue;
    const c = pgConfig(t);
    out[c.name] = {
      columns: c.columns.map((col) => col.name).sort(),
      indexes: c.indexes.map((i) => i.config.name).filter((n) => !PG_ONLY_INDEXES.has(n)).sort(),
    };
  }
  return out;
}

function describeSqlite() {
  const out: Record<string, { columns: string[]; indexes: string[] }> = {};
  for (const t of Object.values(sqlite)) {
    if (!(t instanceof SQLiteTable)) continue;
    const c = sqliteConfig(t);
    out[c.name] = {
      columns: c.columns.map((col) => col.name).sort(),
      indexes: c.indexes.map((i) => i.config.name).sort(),
    };
  }
  return out;
}

describe("schema parity: Postgres vs SQLite / D1", () => {
  it("has the same tables, columns and named indexes", () => {
    expect(describeSqlite()).toEqual(describePg());
  });
});
