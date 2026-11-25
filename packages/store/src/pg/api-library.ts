/**
 * Postgres implementation of the queries used by packages/api/src/routes/library.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiLibraryQueries } from "../areas/api-library.js";

export function pgApiLibrary(db: PgDb): ApiLibraryQueries {
  return {
    async findInstalledLibraryFlow({ tenantId, name }) {
      // Check if already installed (by flow name + source = library)
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id FROM flows
        WHERE tenant_id = ${tenantId}
          AND name = ${name}
          AND source = 'library'
        LIMIT 1
      `);
      return existing.rows.length > 0 ? existing.rows[0]!.id : null;
    },

    async insertTemplateIfAbsent({ tenantId, template: tmpl }) {
      // Idempotent via ON CONFLICT DO NOTHING on tenant_id + slug
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO templates (tenant_id, name, slug, subject, body_html, body_text, variables, category)
        VALUES (
          ${tenantId},
          ${tmpl.name},
          ${tmpl.slug},
          ${tmpl.subject},
          ${tmpl.bodyHtml},
          ${tmpl.bodyText},
          ${sql`ARRAY[${sql.join(tmpl.variables.map(v => sql`${v}`), sql`, `)}]::text[]`},
          ${tmpl.category}
        )
        ON CONFLICT (tenant_id, slug) DO NOTHING
        RETURNING id
      `);
      return result.rows.length > 0;
    },

    async createLibraryFlow({ tenantId, flow, compiledAt }) {
      // Create the flow with pre-compiled plan (compile_status = 'ready')
      const flowResult = await db.execute<{ id: string }>(sql`
        INSERT INTO flows (
          tenant_id, name, description, trigger_type, trigger_config, steps,
          source, status, approval_mode, flow_class, reentry_policy,
          reentry_cooldown_days, priority, compiled_plan, compile_status, compiled_at
        )
        VALUES (
          ${tenantId},
          ${flow.name},
          ${flow.description},
          ${flow.triggerType},
          ${JSON.stringify(flow.triggerConfig)}::jsonb,
          ${JSON.stringify(flow.steps)}::jsonb,
          ${flow.source},
          'draft',
          ${flow.approvalMode},
          ${flow.flowClass},
          ${flow.reentryPolicy},
          ${flow.reentryCooldownDays},
          ${flow.priority},
          ${JSON.stringify(flow.compiledPlan)}::jsonb,
          'ready',
          ${compiledAt}
        )
        RETURNING id
      `);
      return flowResult.rows[0]!.id;
    },
  };
}
