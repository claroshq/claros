/**
 * Queries used by packages/api/src/routes/library.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-library.ts (Postgres) and, later,
 * ../d1/api-library.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A library template to install for a tenant. */
export interface LibraryTemplateInput {
  name: string;
  slug: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: readonly string[];
  category: string;
}

/** A pre-compiled library flow to create for a tenant. */
export interface LibraryFlowInput {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown;
  source: string;
  approvalMode: string;
  flowClass: string;
  reentryPolicy: string;
  reentryCooldownDays: number;
  priority: number;
  compiledPlan: unknown;
}

export interface ApiLibraryQueries {
  /** Id of the tenant's library flow with this name, or null when it is not installed. */
  findInstalledLibraryFlow(input: { tenantId: string; name: string }): Promise<string | null>;
  /** Insert a template unless the tenant already has its slug; true when a row was created. */
  insertTemplateIfAbsent(input: { tenantId: string; template: LibraryTemplateInput }): Promise<boolean>;
  /** Create the library flow as a draft with a ready compiled plan; returns its id. */
  createLibraryFlow(input: { tenantId: string; flow: LibraryFlowInput; compiledAt: Date }): Promise<string>;
}
