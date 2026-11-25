/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-templates.ts.
 */
import { eq } from "drizzle-orm";
import { tenants, flows } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiTemplatesQueries } from "../areas/api-templates.js";

export function d1ApiTemplates(db: D1Db): ApiTemplatesQueries {
  return {
    async getTenantTemplateState({ tenantId }) {
      const rows = await db
        .select({ businessModel: tenants.businessModel, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async setBusinessModel({ tenantId, businessModel, settings }) {
      await db.update(tenants).set({ businessModel, settings }).where(eq(tenants.id, tenantId));
    },

    async insertDraftFlow({ tenantId, flow }) {
      const [inserted] = await db
        .insert(flows)
        .values({
          tenantId,
          name: flow.name,
          description: flow.description,
          priority: 0,
          triggerType: flow.triggerType,
          triggerConfig: flow.triggerConfig,
          steps: flow.steps,
          source: "library",
          status: "draft",
          approvalMode: "require",
          flowClass: flow.flowClass,
          reentryPolicy: flow.reentryPolicy,
          reentryCooldownDays: 30,
          promptSource: flow.promptSource,
          compiledPlan: null,
          compiledAt: null,
          compileStatus: null,
          compileError: null,
        })
        .returning({ id: flows.id, name: flows.name, status: flows.status });
      return inserted ?? null;
    },
  };
}
