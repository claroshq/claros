/**
 * Queries used by packages/worker/src/context-flow.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-context-flow.ts (Postgres) and, later,
 * ../d1/worker-context-flow.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

export interface WorkerContextFlowQueries {
  /**
   * The flow's compiled_plan (parsed JSON, may be null), tenant-scoped;
   * `found: false` when the flow does not exist for the tenant.
   */
  getCompiledPlan(input: {
    tenantId: string;
    flowId: string;
  }): Promise<{ found: false } | { found: true; compiledPlan: unknown }>;
  /**
   * from_name of one active transport config of the tenant; `found: false`
   * when the tenant has no active config (from_name itself may be null).
   */
  getActiveSenderName(tenantId: string): Promise<{ found: false } | { found: true; fromName: string | null }>;
  /** The tenant's name and settings (parsed JSON), or null when the tenant does not exist. */
  getTenantNameAndSettings(tenantId: string): Promise<{ name: string; settings: unknown } | null>;
}
