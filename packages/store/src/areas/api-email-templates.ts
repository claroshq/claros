/**
 * Queries used by packages/api/src/routes/email-templates.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-email-templates.ts (Postgres) and, later,
 * ../d1/api-email-templates.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** An email template as the dashboard sees it. */
export interface EmailTemplateRow {
  id: string;
  name: string;
  slug: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[] | null;
  category: string | null;
  isActive: boolean | null;
  createdAt: Date | null;
}

/** Fields to change on a template; only the keys present are written. */
export interface EmailTemplateUpdate {
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
}

export interface ApiEmailTemplatesQueries {
  /** All email templates of the tenant. */
  listTemplates(input: { tenantId: string }): Promise<EmailTemplateRow[]>;
  /** One template of the tenant, or null. */
  getTemplate(input: { tenantId: string; id: string }): Promise<EmailTemplateRow | null>;
  /** Update a tenant's template content; returns the updated row or null when not found. */
  updateTemplate(input: { tenantId: string; id: string; updates: EmailTemplateUpdate }): Promise<EmailTemplateRow | null>;
}
