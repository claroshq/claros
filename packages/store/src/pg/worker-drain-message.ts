/**
 * Postgres implementation of the queries used by packages/worker/src/drain-message.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerDrainMessageClaimed,
  WorkerDrainMessageQueries,
} from "../areas/worker-drain-message.js";

export function pgWorkerDrainMessage(db: PgDb): WorkerDrainMessageQueries {
  return {
    async claimApprovedMessage(tenantId, messageId, now) {
      // Attempt to claim this single message (CAS: approved -> sending)
      // Also check scheduled_send_at constraint (must be null or <= now)
      const claimed = await db.execute<WorkerDrainMessageClaimed & Record<string, unknown>>(sql`
        UPDATE lifecycle_messages
        SET status = 'sending', updated_at = ${now}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'approved'
          AND (scheduled_send_at IS NULL OR scheduled_send_at <= ${now})
        RETURNING id, tenant_id, contact_id, flow_id, flow_step_order,
                  subject, body_html, body_text, retry_count
      `);
      return claimed.rows[0] ?? null;
    },
  };
}
