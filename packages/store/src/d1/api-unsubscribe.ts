/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-unsubscribe.ts.
 *
 * suppressAddress: one INSERT ... SELECT ... WHERE NOT EXISTS statement (atomic
 * on SQLite; D1 serialises writes), backed by the unique index
 * uq_suppressions_tenant_email_lower (migration 0003). SQLite lower()
 * folds ASCII only, Postgres lower() folds all of Unicode.
 */
import { eq, and, sql } from "drizzle-orm";
import { lifecycleMessages, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiUnsubscribeQueries } from "../areas/api-unsubscribe.js";
import { listContactTopicStatuses, setContactTopicStatuses } from "./contact-topics.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";
import { rawBatch } from "./raw-batch.js";

export function d1ApiUnsubscribe(db: D1Db): ApiUnsubscribeQueries {
  return {
    async getMessageRecipient({ tenantId, messageId }) {
      const rows = await db
        .select({
          recipientAddress: lifecycleMessages.recipientAddress,
          status: lifecycleMessages.status,
          contactId: lifecycleMessages.contactId,
          topicId: lifecycleMessages.topicId,
        })
        .from(lifecycleMessages)
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async suppressAddress({ tenantId, email, reason, source, outbox, now }) {
      const insert = sql`
        INSERT INTO suppressions (id, tenant_id, email, reason, source, created_at)
        SELECT ${crypto.randomUUID()}, ${tenantId}, ${email}, ${reason}, ${source}, ${Date.now()}
        WHERE NOT EXISTS (
          SELECT 1 FROM suppressions WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
        )
      `;
      if (!outbox || outbox.length === 0) {
        await db.run(insert);
        return;
      }
      // The outbox inserts run only when the suppression was new (changes()).
      const endpoints = await d1OutboxEndpoints(db, tenantId, outbox);
      const inserts = d1OutboxInserts(db, tenantId, endpoints, outbox, now ?? new Date(), { afterChange: true });
      await rawBatch(db, [insert, ...inserts.map((i) => i.getSQL())]);
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
