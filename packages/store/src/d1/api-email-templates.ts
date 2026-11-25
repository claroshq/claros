/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-email-templates.ts.
 */
import { eq, and } from "drizzle-orm";
import { templates } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiEmailTemplatesQueries } from "../areas/api-email-templates.js";

const TEMPLATE_COLUMNS = {
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
} as const;

export function d1ApiEmailTemplates(db: D1Db): ApiEmailTemplatesQueries {
  return {
    async listTemplates({ tenantId }) {
      return db.select(TEMPLATE_COLUMNS).from(templates).where(eq(templates.tenantId, tenantId));
    },

    async getTemplate({ tenantId, id }) {
      const rows = await db
        .select(TEMPLATE_COLUMNS)
        .from(templates)
        .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)));
      return rows[0] ?? null;
    },

    async updateTemplate({ tenantId, id, updates }) {
      const rows = await db
        .update(templates)
        .set(updates)
        .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)))
        .returning(TEMPLATE_COLUMNS);
      return rows[0] ?? null;
    },
  };
}
