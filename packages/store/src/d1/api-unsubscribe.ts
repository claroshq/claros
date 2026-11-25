/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-unsubscribe.ts.
 *
 * suppressAddress: the SQLite schema has no (tenant_id, lower(email)) unique
 * index, so ON CONFLICT DO NOTHING becomes one INSERT ... SELECT ... WHERE NOT
 * EXISTS statement (atomic on SQLite; D1 serialises writes). SQLite lower()
 * folds ASCII only, Postgres lower() folds all of Unicode.
 */
import { eq, and, sql } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiUnsubscribeQueries } from "../areas/api-unsubscribe.js";

export function d1ApiUnsubscribe(db: D1Db): ApiUnsubscribeQueries {
  return {
    async getMessageRecipient({ tenantId, messageId }) {
      const rows = await db
        .select({
          recipientAddress: lifecycleMessages.recipientAddress,
          status: lifecycleMessages.status,
        })
        .from(lifecycleMessages)
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async suppressAddress({ tenantId, email, reason, source }) {
      await db.run(sql`
        INSERT INTO suppressions (id, tenant_id, email, reason, source, created_at)
        SELECT ${crypto.randomUUID()}, ${tenantId}, ${email}, ${reason}, ${source}, ${Date.now()}
        WHERE NOT EXISTS (
          SELECT 1 FROM suppressions WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
        )
      `);
    },
  };
}
