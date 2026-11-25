/**
 * Postgres implementation of the queries used by packages/worker/src/embedding-client.ts.
 */
import { eq, and } from "drizzle-orm";
import { llmConfigs } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerEmbeddingClientQueries } from "../areas/worker-embedding-client.js";

export function pgWorkerEmbeddingClient(db: PgDb): WorkerEmbeddingClientQueries {
  return {
    async getActiveLlmConfig(tenantId) {
      // Read the tenant's active LLM config
      const llmRows = await db
        .select()
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      return llmRows[0] ?? null;
    },
  };
}
