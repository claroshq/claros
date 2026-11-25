/**
 * Queries used by packages/worker/src/scan-segment-enrollment.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-segment-enrollment.ts (Postgres) and, later,
 * ../d1/worker-scan-segment-enrollment.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A segment-triggered flow row as phase 2b reads it. */
export interface WorkerScanSegmentEnrollmentFlowRow {
  id: string;
  tenantId: string;
  priority: number | null;
  triggerType: string;
  triggerConfig: unknown;
  flowClass: string;
  reentryPolicy: string;
  reentryCooldownDays: number | null;
}

import type { ContactConditionQueries } from "./shared-conditions.js";

/** Lookups for trigger `where` (P5b) come from ContactConditionQueries. */
export interface WorkerScanSegmentEnrollmentQueries extends ContactConditionQueries {
  /** Tenants (id, settings) ordered by id; restricted to tenantIds when given and non-empty. */
  listTenants(tenantIds?: string[]): Promise<{ id: string; settings: unknown }[]>;
  /** Active, compiled (compile_status = ready, plan present) segment-triggered flows of a tenant. */
  listActiveSegmentFlows(tenantId: string): Promise<WorkerScanSegmentEnrollmentFlowRow[]>;
  /**
   * One keyset page (by id, after afterId) of the tenant's contacts whose
   * tenure and recency ages at `now` fall inside the cell ranges (min days
   * inclusive, max days exclusive, null max = unbounded), excluding contacts
   * already actively enrolled in the flow.
   */
  listCellContactsPage(input: {
    tenantId: string;
    flowId: string;
    now: Date;
    tenure: { minDays: number; maxDays: number | null };
    recency: { minDays: number; maxDays: number | null };
    afterId: string | null;
    limit: number;
  }): Promise<{ id: string }[]>;
  /**
   * P5b: one keyset page (by id, after afterId) of the tenant's contacts whose
   * lifecycle_state is in `states` (any when null) and engagement_depth is in
   * `depths` (any when null), excluding contacts actively enrolled in the flow.
   */
  listStateContactsPage(input: {
    tenantId: string;
    flowId: string;
    states: string[] | null;
    depths: string[] | null;
    afterId: string | null;
    limit: number;
  }): Promise<{ id: string }[]>;
}
