/**
 * Postgres implementation of the queries used by packages/worker/src/process-message.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerProcessMessageClaimed,
  WorkerProcessMessageQueries,
} from "../areas/worker-process-message.js";

export function pgWorkerProcessMessage(db: PgDb): WorkerProcessMessageQueries {
  return {
    async claimPendingGenerationMessage(tenantId, messageId, now) {
      // Attempt to claim this single message (CAS: pending_generation -> generating)
      const claimed = await db.execute<WorkerProcessMessageClaimed & Record<string, unknown>>(sql`
        UPDATE lifecycle_messages
        SET status = 'generating', updated_at = ${now}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'pending_generation'
        RETURNING id, tenant_id, contact_id, flow_id, membership_id,
                  flow_step_order, brain_action_type
      `);
      return claimed.rows[0] ?? null;
    },
  };
}
