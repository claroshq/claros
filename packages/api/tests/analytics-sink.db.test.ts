/**
 * /v1/analytics-sink contract tests on Postgres (see
 * support/analytics-sink-contract.ts). The same suite runs on D1 in
 * analytics-sink-d1.test.ts.
 */
import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@claros/db/schema";
import { buildApp } from "../src/index.js";
import { openDb, dropProduct } from "./support/product.js";
import { analyticsSinkContract, SINK_TEST_LABEL, SINK_TEST_SLUG_PREFIX, type AnalyticsSinkHarness } from "./support/analytics-sink-contract.js";

const { pool, db } = openDb();

afterAll(async () => {
  const rows = await db.execute<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE ${`${SINK_TEST_SLUG_PREFIX}%`}`);
  for (const r of rows.rows) await dropProduct(db, r.id);
  await db.execute(sql`DELETE FROM api_keys WHERE label = ${SINK_TEST_LABEL}`);
  await pool.end();
});

analyticsSinkContract("postgres", async (): Promise<AnalyticsSinkHarness> => {
  const app = await buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async () => null });
  return { app: app as unknown as AnalyticsSinkHarness["app"], db, schema };
});
