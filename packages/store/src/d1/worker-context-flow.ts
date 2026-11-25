/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-flow.ts.
 */
import { and, eq, asc } from "drizzle-orm";
import { flows, tenants, transportConfigs } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerContextFlowQueries } from "../areas/worker-context-flow.js";

export function d1WorkerContextFlow(db: D1Db): WorkerContextFlowQueries {
  return {
    async getCompiledPlan({ tenantId, flowId }) {
      const rows = await db
        .select({ compiledPlan: flows.compiledPlan })
        .from(flows)
        .where(and(eq(flows.id, flowId), eq(flows.tenantId, tenantId)));
      if (rows.length === 0) return { found: false };
      return { found: true, compiledPlan: rows[0]!.compiledPlan ?? null };
    },

    async getActiveSenderName(tenantId) {
      const rows = await db
        .select({ fromName: transportConfigs.fromName })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
        .limit(1);
      if (rows.length === 0) return { found: false };
      return { found: true, fromName: rows[0]!.fromName };
    },

    async getTenantNameAndSettings(tenantId) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (rows.length === 0) return null;
      return { name: rows[0]!.name, settings: rows[0]!.settings ?? null };
    },
  };
}
