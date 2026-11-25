/**
 * Queries used by packages/worker/src/scan-enrollment.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-enrollment.ts (Postgres) and, later,
 * ../d1/worker-scan-enrollment.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A flow row as the lifecycle-transition enrollment phase reads it. */
export interface WorkerScanEnrollmentFlowRow {
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
export interface WorkerScanEnrollmentQueries extends ContactConditionQueries {
  /** Active, compiled (compile_status = ready, plan present) lifecycle-transition flows of a tenant. */
  listActiveLifecycleTransitionFlows(tenantId: string): Promise<WorkerScanEnrollmentFlowRow[]>;
}
