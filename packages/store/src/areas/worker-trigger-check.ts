/**
 * Queries used by packages/worker/src/trigger-check.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-trigger-check.ts (Postgres) and, later,
 * ../d1/worker-trigger-check.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A flow row as the event-trigger enrollment path reads it. */
export interface WorkerTriggerCheckFlowRow {
  id: string;
  tenantId: string;
  priority: number | null;
  triggerType: string;
  triggerConfig: unknown;
  flowClass: string;
  reentryPolicy: string;
  reentryCooldownDays: number | null;
}

export interface WorkerTriggerCheckQueries {
  /** Active, compiled (compile_status = ready, plan present) event-triggered flows of a tenant. */
  listActiveEventFlows(tenantId: string): Promise<WorkerTriggerCheckFlowRow[]>;
}
