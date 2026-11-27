/**
 * MCP endpoint contract tests on Postgres (see support/mcp-contract.ts).
 * The same suite runs on D1 in mcp-d1.test.ts.
 */
import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@claros/db/schema";
import { buildApp } from "../src/index.js";
import { openDb, dropProduct } from "./support/product.js";
import { captureLogger, mcpContract, MCP_TEST_LABEL, MCP_TEST_SLUG_PREFIX, type McpHarness } from "./support/mcp-contract.js";

const { pool, db } = openDb();

afterAll(async () => {
  const rows = await db.execute<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE ${`${MCP_TEST_SLUG_PREFIX}%`}`);
  for (const r of rows.rows) await dropProduct(db, r.id);
  await db.execute(sql`DELETE FROM api_keys WHERE label = ${MCP_TEST_LABEL}`);
  await pool.end();
});

mcpContract("postgres", async (): Promise<McpHarness> => {
  const jobs: McpHarness["jobs"] = [];
  const logs: McpHarness["logs"] = [];
  const app = await buildApp({
    db,
    logger: captureLogger(logs),
    baseUrl: "http://localhost:3000",
    enqueue: async (name: string, data: Record<string, unknown>) => {
      jobs.push({ name, data });
      return null;
    },
  });
  return { app: app as unknown as McpHarness["app"], db, schema, jobs, logs };
});
