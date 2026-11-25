/**
 * Postgres implementation of the queries used by packages/worker/src/provider-resolver.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { llmConfigs, tenantDailyUsage } from "@claros/db/schema";
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

    async addLlmTokens({ tenantId, day, tokens }) {
      if (!(tokens > 0)) return;
      await db
        .insert(tenantDailyUsage)
        .values({ tenantId, day, llmTokens: Math.round(tokens) })
        .onConflictDoUpdate({
          target: [tenantDailyUsage.tenantId, tenantDailyUsage.day],
          set: { llmTokens: sql`${tenantDailyUsage.llmTokens} + ${Math.round(tokens)}` },
        });
    },

    async getLlmTokens({ tenantId, day }) {
      const rows = await db
        .select({ n: tenantDailyUsage.llmTokens })
        .from(tenantDailyUsage)
        .where(and(eq(tenantDailyUsage.tenantId, tenantId), eq(tenantDailyUsage.day, day)))
        .limit(1);
      return Number(rows[0]?.n ?? 0);
    },
  };
}
