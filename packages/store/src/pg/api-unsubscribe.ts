/**
 * Postgres implementation of the queries used by packages/api/src/routes/unsubscribe.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { tenants as tenantsTbl } from "@claros/db/schema";
import { lifecycleMessages, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import { pgWriteOutbox } from "./outbox.js";
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

    async suppressAddress({ tenantId, email, reason, source, outbox, now }) {
      // Idempotent via ON CONFLICT DO NOTHING on (tenant_id, lower(email))
      const insert = (tx: PgDb) =>
        tx.execute(sql`
          INSERT INTO suppressions (tenant_id, email, reason, source)
          VALUES (${tenantId}::uuid, ${email}, ${reason}, ${source})
          ON CONFLICT (tenant_id, lower(email)) DO NOTHING
        `);
      if (!outbox || outbox.length === 0) {
        await insert(db);
        return;
      }
      await db.transaction(async (tx) => {
        const res = await insert(tx as unknown as PgDb);
        if ((res.rowCount ?? 0) > 0) await pgWriteOutbox(tx as unknown as PgDb, tenantId, outbox, now ?? new Date());
      });
    },

    async getTenantLocale(tenantId) {
      const rows = await db.select({ locale: tenantsTbl.locale }).from(tenantsTbl).where(eq(tenantsTbl.id, tenantId)).limit(1);
      return rows[0]?.locale ?? null;
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
