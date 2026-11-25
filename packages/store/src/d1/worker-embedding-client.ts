/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-embedding-client.ts.
 */
import { and, eq } from "drizzle-orm";
import { llmConfigs } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerEmbeddingClientQueries } from "../areas/worker-embedding-client.js";

export function d1WorkerEmbeddingClient(db: D1Db): WorkerEmbeddingClientQueries {
  return {
    async getActiveLlmConfig(tenantId) {
      const rows = await db
        .select()
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
