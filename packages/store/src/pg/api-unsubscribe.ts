/**
 * Postgres implementation of the queries used by packages/api/src/routes/unsubscribe.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { lifecycleMessages, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiUnsubscribeQueries } from "../areas/api-unsubscribe.js";
import { listContactTopicStatuses, setContactTopicStatuses } from "./contact-topics.js";

export function pgApiUnsubscribe(db: PgDb): ApiUnsubscribeQueries {
  return {
    async getMessageRecipient({ tenantId, messageId }) {
      const messageRows = await db
        .select({
          recipientAddress: lifecycleMessages.recipientAddress,
          status: lifecycleMessages.status,
          contactId: lifecycleMessages.contactId,
          topicId: lifecycleMessages.topicId,
        })
        .from(lifecycleMessages)
        .where(
          and(
            eq(lifecycleMessages.id, messageId),
            eq(lifecycleMessages.tenantId, tenantId),
          ),
        )
        .limit(1);
      return messageRows[0] ?? null;
    },

    async suppressAddress({ tenantId, email, reason, source }) {
      // Idempotent via ON CONFLICT DO NOTHING on (tenant_id, lower(email))
      await db.execute(sql`
        INSERT INTO suppressions (tenant_id, email, reason, source)
        VALUES (${tenantId}::uuid, ${email}, ${reason}, ${source})
        ON CONFLICT (tenant_id, lower(email)) DO NOTHING
      `);
    },

    async findTenantIdByPublicHost(host) {
      const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.publicHost, host)).limit(1);
      return rows[0]?.id ?? null;
    },

    listContactTopics({ tenantId, contactId }) {
      return listContactTopicStatuses(db, tenantId, contactId);
    },

    setContactTopicStatuses(input) {
      return setContactTopicStatuses(db, input);
    },
  };
}
