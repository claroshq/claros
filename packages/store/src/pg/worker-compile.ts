/**
 * Postgres implementation of the queries used by packages/worker/src/compile.ts.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { flows, templates, kbEntries, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerCompileQueries } from "../areas/worker-compile.js";

export function pgWorkerCompile(db: PgDb): WorkerCompileQueries {
  return {
    async getFlow(tenantId, flowId) {
      const flowRows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, flowId), eq(flows.tenantId, tenantId)))
        .limit(1);
      return flowRows[0] ?? null;
    },

    async listActiveTemplateSlugs(tenantId) {
      const rows = await db
        .select({ slug: templates.slug })
        .from(templates)
        .where(and(eq(templates.tenantId, tenantId), eq(templates.isActive, true)));
      return rows.map((r) => r.slug);
    },

    async listActiveKbTitles(tenantId) {
      const rows = await db
        .select({ title: kbEntries.title })
        .from(kbEntries)
        .where(and(eq(kbEntries.tenantId, tenantId), eq(kbEntries.isActive, true)));
      return rows.map((r) => r.title);
    },

    async listActiveKbCategories(tenantId) {
      const rows = await db
        .selectDistinct({ category: kbEntries.category })
        .from(kbEntries)
        .where(and(eq(kbEntries.tenantId, tenantId), eq(kbEntries.isActive, true), isNotNull(kbEntries.category)));
      return rows.map((r) => r.category as string).sort();
    },

    async getTenantSettings(tenantId) {
      const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      const v = rows[0]?.settings;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    },

    async markCompileReady(flowId, plan) {
      const updated = await db
        .update(flows)
        .set({
          compiledPlan: plan,
          compiledAt: new Date(),
          compileStatus: "ready",
          compileError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, flowId), eq(flows.compileStatus, "pending")))
        .returning({ id: flows.id });
      return updated.length > 0;
    },

    async markCompileFailed(flowId, error) {
      const updated = await db
        .update(flows)
        .set({
          compileStatus: "failed",
          compileError: error,
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, flowId), eq(flows.compileStatus, "pending")))
        .returning({ id: flows.id });
      return updated.length > 0;
    },
  };
}
