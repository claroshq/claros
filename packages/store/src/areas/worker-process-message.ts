/**
 * Queries used by packages/worker/src/process-message.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-process-message.ts (Postgres) and, later,
 * ../d1/worker-process-message.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A lifecycle message claimed for content generation (raw column names). */
export interface WorkerProcessMessageClaimed {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  membership_id: string;
  flow_step_order: number | null;
  brain_action_type: string | null;
}

export interface WorkerProcessMessageQueries {
  /**
   * CAS pending_generation -> generating for one message. Returns the claimed row, or null
   * when it is no longer pending_generation; exactly one concurrent caller gets the row.
   */
  claimPendingGenerationMessage(tenantId: string, messageId: string, now: Date): Promise<WorkerProcessMessageClaimed | null>;
}
