/**
 * Postgres implementation of the queries used by packages/worker/src/context-flow.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { WorkerContextFlowQueries } from "../areas/worker-context-flow.js";

type FlowPlanRow = Record<string, unknown> & {
  compiled_plan: unknown; // JSONB arrives as parsed object or null
};

type TransportRow = Record<string, unknown> & {
  from_name: string | null;
};

type TenantRow = Record<string, unknown> & {
  name: string;
  settings: unknown; // JSONB arrives as parsed object or null
};

export function pgWorkerContextFlow(db: PgDb): WorkerContextFlowQueries {
  return {
    async getCompiledPlan({ tenantId, flowId }) {
      const flowRows = await db.execute<FlowPlanRow>(sql`
        SELECT compiled_plan
        FROM flows
        WHERE id        = ${flowId}::uuid
          AND tenant_id = ${tenantId}::uuid
      `);
      if (flowRows.rows.length === 0) return { found: false };
      return { found: true, compiledPlan: flowRows.rows[0]!.compiled_plan };
    },

    async getActiveSenderName(tenantId) {
      const transportRows = await db.execute<TransportRow>(sql`
        SELECT from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `);
      if (transportRows.rows.length === 0) return { found: false };
      return { found: true, fromName: transportRows.rows[0]!.from_name };
    },

    async getTenantNameAndSettings(tenantId) {
      const tenantRows = await db.execute<TenantRow>(sql`
        SELECT name, settings
        FROM tenants
        WHERE id = ${tenantId}::uuid
      `);
      if (tenantRows.rows.length === 0) return null;
      return { name: tenantRows.rows[0]!.name, settings: tenantRows.rows[0]!.settings };
    },
  };
}
