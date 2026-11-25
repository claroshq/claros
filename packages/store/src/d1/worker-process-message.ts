/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-process-message.ts.
 *
 * The claim is one guarded UPDATE ... RETURNING (CAS pending_generation -> generating),
 * atomic in SQLite.
 */
import { and, eq } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerProcessMessageQueries } from "../areas/worker-process-message.js";

export function d1WorkerProcessMessage(db: D1Db): WorkerProcessMessageQueries {
  return {
    async claimPendingGenerationMessage(tenantId, messageId, now) {
      const rows = await db
        .update(lifecycleMessages)
        .set({ status: "generating", updatedAt: now })
        .where(
          and(
            eq(lifecycleMessages.id, messageId),
            eq(lifecycleMessages.tenantId, tenantId),
            eq(lifecycleMessages.status, "pending_generation"),
          ),
        )
        .returning({
          id: lifecycleMessages.id,
          tenant_id: lifecycleMessages.tenantId,
          contact_id: lifecycleMessages.contactId,
          flow_id: lifecycleMessages.flowId,
          membership_id: lifecycleMessages.membershipId,
          flow_step_order: lifecycleMessages.flowStepOrder,
          brain_action_type: lifecycleMessages.brainActionType,
          forced_action_type: lifecycleMessages.forcedActionType,
        });
      return rows[0] ?? null;
    },
  };
}
