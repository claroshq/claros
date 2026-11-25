/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-drain-message.ts.
 *
 * The claim is one guarded UPDATE ... RETURNING (CAS approved -> sending), atomic in SQLite.
 */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerDrainMessageQueries } from "../areas/worker-drain-message.js";

export function d1WorkerDrainMessage(db: D1Db): WorkerDrainMessageQueries {
  return {
    async claimApprovedMessage(tenantId, messageId, now) {
      const rows = await db
        .update(lifecycleMessages)
        .set({ status: "sending", updatedAt: now })
        .where(
          and(
            eq(lifecycleMessages.id, messageId),
            eq(lifecycleMessages.tenantId, tenantId),
            eq(lifecycleMessages.status, "approved"),
            or(isNull(lifecycleMessages.scheduledSendAt), lte(lifecycleMessages.scheduledSendAt, now)),
          ),
        )
        .returning({
          id: lifecycleMessages.id,
          tenant_id: lifecycleMessages.tenantId,
          contact_id: lifecycleMessages.contactId,
          flow_id: lifecycleMessages.flowId,
          flow_step_order: lifecycleMessages.flowStepOrder,
          subject: lifecycleMessages.subject,
          body_html: lifecycleMessages.bodyHtml,
          body_text: lifecycleMessages.bodyText,
          retry_count: lifecycleMessages.retryCount,
        });
      return rows[0] ?? null;
    },
  };
}
