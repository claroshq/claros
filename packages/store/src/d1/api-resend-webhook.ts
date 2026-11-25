/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-resend-webhook.ts.
 *
 * - findActiveResendConfig: Postgres casts tenantId to uuid (throws on a
 *   malformed id) and returns config::text. Here the id is validated with the
 *   same accepted forms and normalised to the canonical lowercase form; the
 *   stored config text is returned as is (a JSON string literal is unwrapped).
 * - Feedback CAS updates are single UPDATE ... WHERE <guard> RETURNING id
 *   statements (atomic on SQLite); NOW() is bound from JS.
 * - insertSuppression: INSERT ... SELECT ... WHERE NOT EXISTS (one statement),
 *   backed by the unique index uq_suppressions_tenant_email_lower.
 * - insertMessageEvent: ON CONFLICT on the partial unique index
 *   uq_message_events_provider_dedup, same as Postgres.
 */
import { eq, and, sql, inArray, isNull, or, type SQL } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiResendWebhookQueries } from "../areas/api-resend-webhook.js";

/** Forms Postgres accepts for uuid input: optional braces, hyphens after any group of four. */
const PG_UUID_INPUT = /^\{?[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}?$/i;

function canonicalUuid(value: string): string {
  if (!PG_UUID_INPUT.test(value) || value.startsWith("{") !== value.endsWith("}")) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
  const hex = value.replace(/[{}-]/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function d1ApiResendWebhook(db: D1Db): ApiResendWebhookQueries {
  return {
    async findActiveResendConfig(tenantId) {
      const id = canonicalUuid(tenantId);
      const rows = await db.all<{ config: string }>(sql`
        SELECT config FROM transport_configs
        WHERE tenant_id = ${id} AND provider = 'resend' AND is_active = 1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `);
      const raw = rows[0]?.config;
      if (raw == null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "string") return parsed;
      } catch {
        // not JSON: return the text as stored
      }
      return raw;
    },

    async setTerminalFeedback({ messageId, feedback }) {
      const rows = await db
        .update(lifecycleMessages)
        .set({ feedback, updatedAt: new Date() })
        .where(
          and(
            eq(lifecycleMessages.id, messageId),
            sql`(${lifecycleMessages.feedback} IS NULL OR ${lifecycleMessages.feedback} NOT IN ('bounced', 'complained'))`,
          ),
        )
        .returning({ id: lifecycleMessages.id });
      return rows.length > 0;
    },

    async advanceFeedback({ messageId, feedback, predecessors }) {
      const nonNull = predecessors.filter((p): p is string => p !== null);
      const guards: SQL[] = [];
      if (predecessors.includes(null)) guards.push(isNull(lifecycleMessages.feedback));
      if (nonNull.length > 0) guards.push(inArray(lifecycleMessages.feedback, nonNull));
      if (guards.length === 0) return false;
      const rows = await db
        .update(lifecycleMessages)
        .set({ feedback, updatedAt: new Date() })
        .where(and(eq(lifecycleMessages.id, messageId), or(...guards)))
        .returning({ id: lifecycleMessages.id });
      return rows.length > 0;
    },

    async insertSuppression({ tenantId, email, reason }) {
      await db.run(sql`
        INSERT INTO suppressions (id, tenant_id, email, reason, source, created_at)
        SELECT ${crypto.randomUUID()}, ${tenantId}, ${email}, ${reason}, 'webhook', ${Date.now()}
        WHERE NOT EXISTS (
          SELECT 1 FROM suppressions WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
        )
      `);
    },

    async findMessageByProviderId({ tenantId, providerMessageId }) {
      const rows = await db
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
      return rows[0] ?? null;
    },

    async countMessageEvents(messageId) {
      const rows = await db.all<{ cnt: number }>(sql`
        SELECT count(*) AS cnt FROM message_events WHERE message_id = ${messageId}
      `);
      return Number(rows[0]?.cnt ?? 0);
    },

    async insertMessageEvent({ tenantId, messageId, eventType, occurredAt, providerEventId, metadataJson }) {
      const occurredMs = new Date(occurredAt).getTime();
      if (Number.isNaN(occurredMs)) {
        throw new Error(`invalid input syntax for type timestamp with time zone: "${occurredAt}"`);
      }
      // Postgres validates metadata with ::jsonb; keep the same failure mode.
      const metadata = metadataJson === null ? null : JSON.stringify(JSON.parse(metadataJson));
      await db.run(sql`
        INSERT INTO message_events (id, tenant_id, message_id, event_type, occurred_at, provider_event_id, metadata, created_at)
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${messageId}, ${eventType}, ${occurredMs}, ${providerEventId}, ${metadata}, ${Date.now()})
        ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
        DO NOTHING
      `);
    },
  };
}
