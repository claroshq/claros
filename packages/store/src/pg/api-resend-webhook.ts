/**
 * Postgres implementation of the queries used by packages/api/src/routes/webhooks/resend.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiResendWebhookQueries } from "../areas/api-resend-webhook.js";

/** A transport_configs row for webhook secret resolution. */
interface TransportConfigSecretRow extends Record<string, unknown> {
  config: string;
}

export function pgApiResendWebhook(db: PgDb): ApiResendWebhookQueries {
  return {
    async findActiveResendConfig(tenantId) {
      const rows = await db.execute<TransportConfigSecretRow>(sql`
        SELECT config::text AS config
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND provider = 'resend'
          AND is_active = true
        LIMIT 1
      `);
      return rows.rows[0]?.config ?? null;
    },

    async setTerminalFeedback({ messageId, feedback }) {
      // Terminal states override anything except another terminal.
      // Guard: WHERE feedback NOT IN ('bounced', 'complained') OR feedback IS NULL
      const result = await db.execute(sql`
        UPDATE lifecycle_messages
        SET feedback = ${feedback}, updated_at = NOW()
        WHERE id = ${messageId}::uuid
          AND (feedback IS NULL OR feedback NOT IN ('bounced', 'complained'))
      `);
      return (result.rowCount ?? 0) > 0;
    },

    async advanceFeedback({ messageId, feedback, predecessors }) {
      // Build WHERE clause: feedback IS NULL OR feedback IN (predecessors excluding null)
      const nonNullPredecessors = predecessors.filter((p) => p !== null) as string[];
      const includesNull = predecessors.includes(null);

      let whereClause: ReturnType<typeof sql>;
      if (includesNull && nonNullPredecessors.length > 0) {
        // feedback IS NULL OR feedback IN (...)
        const inList = nonNullPredecessors.map((p) => `'${p}'`).join(", ");
        whereClause = sql`(feedback IS NULL OR feedback IN (${sql.raw(inList)}))`;
      } else if (includesNull) {
        whereClause = sql`feedback IS NULL`;
      } else {
        const inList = nonNullPredecessors.map((p) => `'${p}'`).join(", ");
        whereClause = sql`feedback IN (${sql.raw(inList)})`;
      }

      const result = await db.execute(sql`
        UPDATE lifecycle_messages
        SET feedback = ${feedback}, updated_at = NOW()
        WHERE id = ${messageId}::uuid
          AND ${whereClause}
      `);

      return (result.rowCount ?? 0) > 0;
    },

    async insertSuppression({ tenantId, email, reason }) {
      await db.execute(sql`
        INSERT INTO suppressions (tenant_id, email, reason, source)
        VALUES (${tenantId}::uuid, ${email}, ${reason}, 'webhook')
        ON CONFLICT (tenant_id, lower(email)) DO NOTHING
      `);
    },

    async findMessageByProviderId({ tenantId, providerMessageId }) {
      const messageRows = await db
        .select({
          id: lifecycleMessages.id,
          tenantId: lifecycleMessages.tenantId,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(
          and(
            eq(lifecycleMessages.providerMessageId, providerMessageId),
            eq(lifecycleMessages.tenantId, tenantId),
          ),
        )
        .limit(1);
      return messageRows[0] ?? null;
    },

    async countMessageEvents(messageId) {
      const countResult = await db.execute<{ cnt: number }>(sql`
        SELECT count(*)::int AS cnt
        FROM message_events
        WHERE message_id = ${messageId}::uuid
      `);
      return countResult.rows[0]?.cnt ?? 0;
    },

    async insertMessageEvent({ tenantId, messageId, eventType, occurredAt, providerEventId, metadataJson }) {
      await db.execute(sql`
        INSERT INTO message_events (tenant_id, message_id, event_type, occurred_at, provider_event_id, metadata)
        VALUES (
          ${tenantId}::uuid,
          ${messageId}::uuid,
          ${eventType},
          ${occurredAt}::timestamptz,
          ${providerEventId},
          ${metadataJson}::jsonb
        )
        ON CONFLICT (tenant_id, provider_event_id)
          WHERE provider_event_id IS NOT NULL
        DO NOTHING
      `);
    },
  };
}
