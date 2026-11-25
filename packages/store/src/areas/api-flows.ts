/**
 * Queries used by packages/api/src/routes/flows.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-flows.ts (Postgres) and, later,
 * ../d1/api-flows.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A flows row (all columns). JSON columns are returned parsed. */
export interface ApiFlowRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  priority: number | null;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown;
  source: string | null;
  contentMode: string | null;
  status: string | null;
  approvalMode: string | null;
  flowClass: string;
  reentryPolicy: string;
  reentryCooldownDays: number | null;
  promptSource: string | null;
  compiledPlan: unknown;
  compiledAt: Date | null;
  compileStatus: string | null;
  compileError: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Fields a PATCH may set on a flow; absent keys are left unchanged. */
export interface ApiFlowPatch {
  updatedAt: Date;
  name?: string;
  description?: string;
  priority?: number;
  triggerType?: string;
  triggerConfig?: Record<string, unknown>;
  steps?: unknown[];
  source?: string;
  contentMode?: string;
  approvalMode?: string;
  flowClass?: string;
  reentryPolicy?: string;
  reentryCooldownDays?: number;
  status?: string;
  promptSource?: string;
  compiledPlan?: null;
  compiledAt?: null;
  compileStatus?: null;
  compileError?: null;
}

export interface ApiFlowsQueries {
  /** Insert a flow and return the full row. */
  createFlow(values: {
    tenantId: string;
    name: string;
    description: string | null;
    priority: number;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    steps: unknown[];
    source: string;
    contentMode: string;
    status: string;
    approvalMode: string;
    flowClass: string;
    reentryPolicy: string;
    reentryCooldownDays: number;
    promptSource: string | null;
    compiledPlan: null;
    compiledAt: null;
  }): Promise<ApiFlowRow | undefined>;
  /** The tenant's flows ordered by created_at; archived ones only when includeArchived. */
  listFlows(args: { tenantId: string; includeArchived: boolean }): Promise<ApiFlowRow[]>;
  /** The tenant's flow by id, or null. */
  findFlow(args: { tenantId: string; id: string }): Promise<ApiFlowRow | null>;
  /**
   * Apply a partial update to the tenant's flow and return the updated row.
   * When expectedStatus is given the update is a CAS on the current status:
   * it returns null if the status changed concurrently (or the flow is gone).
   */
  updateFlow(args: {
    tenantId: string;
    id: string;
    patch: ApiFlowPatch;
    expectedStatus?: string;
  }): Promise<ApiFlowRow | null>;
  /** Set the tenant's flow to 'archived' and return the updated row. */
  archiveFlow(args: { tenantId: string; id: string; now: Date }): Promise<ApiFlowRow | undefined>;
  /** True when the tenant has an active LLM configuration. */
  hasActiveLlmConfig(tenantId: string): Promise<boolean>;
  /** Set compile_status = 'pending' and clear compile_error on the tenant's flow. */
  markCompilePending(args: { tenantId: string; id: string; now: Date }): Promise<void>;
  /** Insert or update (by tenant and slug) the template for one fixed_content step. */
  upsertStepTemplate(args: {
    tenantId: string;
    name: string;
    slug: string;
    subject: string;
    bodyHtml: string;
    bodyText: string | null;
    variables: string[];
  }): Promise<void>;
  /**
   * Store a hand-authored compiled plan and its steps on the tenant's flow
   * (compile_status = 'ready') and return the updated row.
   */
  saveFixedPlan(args: {
    tenantId: string;
    id: string;
    compiledPlan: Record<string, unknown>;
    steps: unknown[];
    compiledAt: Date;
    updatedAt: Date;
  }): Promise<ApiFlowRow | undefined>;
  /** Encrypted config of the tenant's active LLM configuration, or null. */
  findActiveLlmConfig(tenantId: string): Promise<{ config: string } | null>;
  /** Tenant display name, or null when the tenant does not exist. */
  findTenantName(tenantId: string): Promise<string | null>;
}
