/**
 * Test backends for Store contract tests.
 *
 * Contract tests run the same assertions against every backend:
 *
 *   for (const backend of testBackends()) {
 *     describe(backend.name, () => {
 *       let b: Backend;
 *       beforeAll(async () => { b = await backend.open(); });
 *       afterAll(async () => { await b.close(); });
 *       it("...", async () => { const t = await b.newTenant(); ... b.store.apiKb ... });
 *     });
 *   }
 *
 * - pg: the local Postgres from DATABASE_URL (skipped when unset).
 * - d1: a fresh in-memory D1 database from Miniflare (the same engine
 *   wrangler dev uses), with drizzle/migrations-sqlite applied.
 *
 * Both schemas use the same JS property names, so fixtures can be inserted
 * with `b.db.insert(b.schema.contacts).values({...})` on either backend.
 * Tests isolate themselves by creating their own tenant (newTenant()).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as pgSchema from "@claros/db/schema";
import * as sqliteSchema from "@claros/db/schema-sqlite";
import { createPgStore, createD1Store, type Store } from "../../src/index.js";

export interface Backend {
  readonly name: "pg" | "d1";
  readonly store: Store;
  /** Drizzle handle (node-postgres or D1); typed loosely for fixtures. */
  readonly db: any;
  /** Schema objects for this backend (same property names on both). */
  readonly schema: typeof pgSchema | typeof sqliteSchema;
  /** Insert a tenant with a unique slug and return its id. */
  newTenant(name?: string): Promise<string>;
  close(): Promise<void>;
}

export interface BackendFactory {
  readonly name: "pg" | "d1";
  readonly available: boolean;
  open(): Promise<Backend>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

async function newTenant(db: any, schema: any, name = "Test"): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.tenants).values({ id, name, slug: `t-${id.slice(0, 8)}` });
  return id;
}

const pgFactory: BackendFactory = {
  name: "pg",
  available: Boolean(process.env.DATABASE_URL),
  async open() {
    const { default: pg } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const db = drizzle(pool);
    return {
      name: "pg",
      store: createPgStore(db as never),
      db,
      schema: pgSchema,
      newTenant: (n) => newTenant(db, pgSchema, n),
      close: () => pool.end(),
    };
  },
};

const d1Factory: BackendFactory = {
  name: "d1",
  available: true,
  async open() {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
    const { drizzle } = await import("drizzle-orm/d1");
    const mf = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }),
    );
    const d1 = await mf.getD1Database("DB");
    const dir = join(repoRoot, "drizzle", "migrations-sqlite");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
        if (stmt.trim()) await d1.prepare(stmt).run();
      }
    }
    const db = drizzle(d1 as never);
    return {
      name: "d1",
      store: createD1Store(db as never),
      db,
      schema: sqliteSchema,
      newTenant: (n) => newTenant(db, sqliteSchema, n),
      close: () => mf.dispose(),
    };
  },
};

/** Backends to run contract tests against (pg only when DATABASE_URL is set). */
export function testBackends(): BackendFactory[] {
  return [pgFactory, d1Factory].filter((b) => b.available);
}
