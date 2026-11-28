/**
 * /v1/analytics-sink contract tests on D1 (Miniflare, the engine wrangler
 * dev uses), with the SQLite migrations applied. The same suite runs on
 * Postgres in analytics-sink.db.test.ts.
 */
import { afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore } from "@claros/store";
import { buildApp } from "../src/app.js";
import { analyticsSinkContract, type AnalyticsSinkHarness } from "./support/analytics-sink-contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let mf: any;

afterAll(async () => {
  await mf?.dispose();
});

analyticsSinkContract("d1", async (): Promise<AnalyticsSinkHarness> => {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
  const d1 = await mf.getD1Database("DB");
  const dir = join(repoRoot, "drizzle", "migrations-sqlite");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await d1.prepare(stmt).run();
    }
  }
  const { drizzle } = await import("drizzle-orm/d1");
  const db = drizzle(d1 as never);
  registerStore(db, createD1Store(db));
  const app = await buildApp({ db: db as never, logger: false, baseUrl: "http://localhost:3000", enqueue: async () => null });
  return { app: app as unknown as AnalyticsSinkHarness["app"], db, schema };
});
