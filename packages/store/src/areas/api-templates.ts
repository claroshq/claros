/**
 * Queries used by packages/api/src/routes/templates.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-templates.ts (Postgres) and, later,
 * ../d1/api-templates.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A draft flow created from a business model template (not compiled). */
export interface TemplateDraftFlowInput {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown[];
  flowClass: string;
  reentryPolicy: string;
  promptSource: string;
}

export interface ApiTemplatesQueries {
  /** The tenant's business model and settings, or null when the tenant does not exist. */
  getTenantTemplateState(input: { tenantId: string }): Promise<{ businessModel: string | null; settings: unknown } | null>;
  /** Write the tenant's business model and settings in a single update. */
  setBusinessModel(input: { tenantId: string; businessModel: string; settings: Record<string, unknown> }): Promise<void>;
  /** Insert one template flow as a library draft; returns the created row or null. */
  insertDraftFlow(input: { tenantId: string; flow: TemplateDraftFlowInput }): Promise<{ id: string; name: string; status: string | null } | null>;
}
