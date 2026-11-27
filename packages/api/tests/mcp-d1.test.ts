/**
 * MCP endpoint contract tests on D1 (Miniflare, the engine wrangler dev
 * uses), with the SQLite migrations applied. The same suite runs on
 * Postgres in mcp.db.test.ts (see support/mcp-contract.ts).
 */
import { afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore } from "@claros/store";
import { buildApp } from "../src/app.js";
import { captureLogger, mcpContract, type McpHarness } from "./support/mcp-contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let mf: any;

afterAll(async () => {
  await mf?.dispose();
});

mcpContract("d1", async (): Promise<McpHarness> => {
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
  const jobs: McpHarness["jobs"] = [];
  const logs: McpHarness["logs"] = [];
  const app = await buildApp({
    db: db as never,
    logger: captureLogger(logs),
    baseUrl: "http://localhost:3000",
    enqueue: async (name: string, data: Record<string, unknown>) => {
      jobs.push({ name, data });
      return null;
    },
  });
  return { app: app as unknown as McpHarness["app"], db, schema, jobs, logs };
});
