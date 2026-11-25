/**
 * Postgres implementation of the queries used by packages/worker/src/provider-resolver.ts.
 */
import { eq, and } from "drizzle-orm";
import { llmConfigs } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerProviderResolverQueries } from "../areas/worker-provider-resolver.js";

export function pgWorkerProviderResolver(db: PgDb): WorkerProviderResolverQueries {
  return {
    async getActiveLlmConfig(tenantId) {
      const llmRows = await db
        .select()
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      return llmRows[0] ?? null;
    },
  };
}
