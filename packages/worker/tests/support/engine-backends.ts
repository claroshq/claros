/**
 * Engine scenario tests on both backends: the local Postgres (when
 * DATABASE_URL is set) and an in-memory D1 database (Miniflare) with the
 * SQLite migrations applied and its Store registered. Worker code resolves
 * the Store from the handle (storeFor), so the same scenario runs on both.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as pgSchema from "@claros/db/schema";
import * as sqliteSchema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore } from "@claros/store";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface EngineBackend {
  name: "pg" | "d1";
  db: any;
  schema: any;
  newTenant(settings?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface EngineBackendFactory {
  name: "pg" | "d1";
  open(): Promise<EngineBackend>;
}

async function newTenant(db: any, schema: any, settings?: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.tenants).values({ id, name: "Test", slug: `t-${id.slice(0, 8)}`, settings: settings ?? null });
  return id;
}

const pg: EngineBackendFactory = {
  name: "pg",
  async open() {
    const { default: pgLib } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pgLib.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const db = drizzle(pool);
    return { name: "pg", db, schema: pgSchema, newTenant: (s) => newTenant(db, pgSchema, s), close: () => pool.end() };
  },
};

const d1: EngineBackendFactory = {
  name: "d1",
  async open() {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
    const { drizzle } = await import("drizzle-orm/d1");
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
    const binding = await mf.getD1Database("DB");
    const dir = join(repoRoot, "drizzle", "migrations-sqlite");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
        if (stmt.trim()) await binding.prepare(stmt).run();
      }
    }
    const db = drizzle(binding as never);
    registerStore(db, createD1Store(db as never));
    return { name: "d1", db, schema: sqliteSchema, newTenant: (s) => newTenant(db, sqliteSchema, s), close: () => mf.dispose() };
  },
};

/** Backends to run engine scenarios on (Postgres only when DATABASE_URL is set). */
export function engineBackends(): EngineBackendFactory[] {
  return process.env.DATABASE_URL ? [pg, d1] : [d1];
}
