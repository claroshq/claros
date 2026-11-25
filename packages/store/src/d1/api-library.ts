/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-library.ts.
 */
import { and, eq } from "drizzle-orm";
import { flows, templates } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiLibraryQueries } from "../areas/api-library.js";

export function d1ApiLibrary(db: D1Db): ApiLibraryQueries {
  return {
    async findInstalledLibraryFlow({ tenantId, name }) {
      const rows = await db
        .select({ id: flows.id })
        .from(flows)
        .where(and(eq(flows.tenantId, tenantId), eq(flows.name, name), eq(flows.source, "library")))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async insertTemplateIfAbsent({ tenantId, template: tmpl }) {
      // Idempotent via ON CONFLICT DO NOTHING on uq_templates_tenant_slug.
      const rows = await db
        .insert(templates)
        .values({
          tenantId,
          name: tmpl.name,
          slug: tmpl.slug,
          subject: tmpl.subject,
          bodyHtml: tmpl.bodyHtml,
          bodyText: tmpl.bodyText,
          variables: [...tmpl.variables],
          category: tmpl.category,
        })
        .onConflictDoNothing({ target: [templates.tenantId, templates.slug] })
        .returning({ id: templates.id });
      return rows.length > 0;
    },

    async createLibraryFlow({ tenantId, flow, compiledAt }) {
      const [row] = await db
        .insert(flows)
        .values({
          tenantId,
          name: flow.name,
          description: flow.description,
          triggerType: flow.triggerType,
          triggerConfig: flow.triggerConfig,
          steps: flow.steps,
          source: flow.source,
          status: "draft",
          approvalMode: flow.approvalMode,
          flowClass: flow.flowClass,
          reentryPolicy: flow.reentryPolicy,
          reentryCooldownDays: flow.reentryCooldownDays,
          priority: flow.priority,
          compiledPlan: flow.compiledPlan,
          compileStatus: "ready",
          compiledAt,
        })
        .returning({ id: flows.id });
      return row!.id;
    },
  };
}
