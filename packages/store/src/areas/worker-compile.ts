/**
 * Queries used by packages/worker/src/compile.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-compile.ts (Postgres) and, later,
 * ../d1/worker-compile.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** The flow fields the compile worker reads. */
export interface WorkerCompileFlow {
  id: string;
  tenantId: string;
  triggerType: string;
  triggerConfig: unknown;
  promptSource: string | null;
  compileStatus: string | null;
}

export interface WorkerCompileQueries {
  /** The tenant's flow by id, or null when it does not exist. */
  getFlow(tenantId: string, flowId: string): Promise<WorkerCompileFlow | null>;
  /** Slugs of the tenant's active templates. */
  listActiveTemplateSlugs(tenantId: string): Promise<string[]>;
  /** Titles of the tenant's active KB entries. */
  listActiveKbTitles(tenantId: string): Promise<string[]>;
  /** P5b: distinct categories of the tenant's active KB entries, sorted (kb_select in compiled plans). */
  listActiveKbCategories(tenantId: string): Promise<string[]>;
  /** P5b: the tenant's settings JSON (named links and data sources for the compile prompt), or null. */
  getTenantSettings(tenantId: string): Promise<Record<string, unknown> | null>;
  /** CAS pending -> ready with the compiled plan; true when this call won. */
  markCompileReady(flowId: string, plan: unknown): Promise<boolean>;
  /** CAS pending -> failed with an error (caller truncates); true when this call won. */
  markCompileFailed(flowId: string, error: string): Promise<boolean>;
}
