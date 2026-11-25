/**
 * Postgres implementation of the queries used by packages/api/src/routes/email-templates.ts.
 */
import { eq, and } from "drizzle-orm";
import { templates } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiEmailTemplatesQueries } from "../areas/api-email-templates.js";

export function pgApiEmailTemplates(db: PgDb): ApiEmailTemplatesQueries {
  return {
    async listTemplates({ tenantId }) {
      return db
        .select({
          id: templates.id,
          name: templates.name,
          slug: templates.slug,
          subject: templates.subject,
          bodyHtml: templates.bodyHtml,
          bodyText: templates.bodyText,
          variables: templates.variables,
          category: templates.category,
          isActive: templates.isActive,
          createdAt: templates.createdAt,
        })
        .from(templates)
        .where(eq(templates.tenantId, tenantId));
    },

    async getTemplate({ tenantId, id }) {
      const rows = await db
        .select({
          id: templates.id,
          name: templates.name,
          slug: templates.slug,
          subject: templates.subject,
          bodyHtml: templates.bodyHtml,
          bodyText: templates.bodyText,
          variables: templates.variables,
          category: templates.category,
          isActive: templates.isActive,
          createdAt: templates.createdAt,
        })
        .from(templates)
        .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)));
      return rows[0] ?? null;
    },

    async updateTemplate({ tenantId, id, updates }) {
      const result = await db
        .update(templates)
        .set(updates)
        .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)))
        .returning({
          id: templates.id,
          name: templates.name,
          slug: templates.slug,
          subject: templates.subject,
          bodyHtml: templates.bodyHtml,
          bodyText: templates.bodyText,
          variables: templates.variables,
          category: templates.category,
          isActive: templates.isActive,
          createdAt: templates.createdAt,
        });
      return result[0] ?? null;
    },
  };
}
