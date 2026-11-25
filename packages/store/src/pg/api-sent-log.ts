/**
 * Postgres implementation of the queries used by packages/api/src/routes/sent-log.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  ApiSentLogQueries,
  SentLogRow,
  SentLogDetailRow,
  SentLogEventRow,
} from "../areas/api-sent-log.js";

export function pgApiSentLog(db: PgDb): ApiSentLogQueries {
  return {
    async listSentMessages({ tenantId, filter, limit }) {
      // Build WHERE conditions
      const conditions: ReturnType<typeof sql>[] = [
        sql`m.tenant_id = ${tenantId}`,
      ];

      // Status filter: default shows all sent-log statuses
      if (filter.status !== null) {
        conditions.push(sql`m.status = ${filter.status}`);
      } else {
        conditions.push(
          sql`m.status IN ('sending', 'sent', 'failed', 'suppressed')`
        );
      }

      // Flow filter
      if (filter.flowId !== null) {
        conditions.push(sql`m.flow_id = ${filter.flowId}::uuid`);
      }

      // Recipient search (ILIKE on address, contact email, or contact name)
      if (filter.recipient !== null) {
        const pattern = `%${filter.recipient}%`;
        conditions.push(
          sql`(
            m.recipient_address ILIKE ${pattern}
            OR c.email ILIKE ${pattern}
            OR c.name ILIKE ${pattern}
          )`
        );
      }

      // Date range on sent_at
      if (filter.from !== null) {
        conditions.push(sql`m.sent_at >= ${filter.from}::timestamptz`);
      }
      if (filter.to !== null) {
        conditions.push(sql`m.sent_at <= ${filter.to}::timestamptz`);
      }

      // Feedback filter
      if (filter.feedback !== null) {
        if (filter.feedback === "opened") {
          // opened-or-better (includes clicked)
          conditions.push(sql`m.feedback IN ('opened', 'clicked')`);
        } else {
          conditions.push(sql`m.feedback = ${filter.feedback}`);
        }
      }

      // Cursor
      if (filter.before !== null) {
        // DESC order: next page has OLDER messages
        conditions.push(
          sql`ROW(date_trunc('milliseconds', m.sent_at), m.id) < ROW(${filter.before.sentAt}::timestamptz, ${filter.before.id}::uuid)`
        );
      }

      const whereClause = sql.join(conditions, sql` AND `);

      const result = await db.execute<SentLogRow>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id,
               f.name AS flow_name,
               m.status, m.feedback, m.subject, m.recipient_address,
               m.sent_at, m.created_at,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE ${whereClause}
        ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
        LIMIT ${limit}
      `);
      return result.rows;
    },

    async getSentMessage({ tenantId, messageId }) {
      const msgResult = await db.execute<SentLogDetailRow>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id,
               f.name AS flow_name, f.compiled_plan AS flow_compiled_plan,
               m.membership_id, m.flow_step_order,
               m.status, m.feedback, m.subject, m.body_html, m.body_text,
               m.brain_reasoning, m.brain_action_type,
               m.scheduled_send_at, m.approved_at, m.sent_at,
               m.created_at, m.updated_at, m.retry_count,
               m.provider_message_id, m.recipient_address,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE m.id = ${messageId}::uuid
          AND m.tenant_id = ${tenantId}
      `);
      return msgResult.rows[0] ?? null;
    },

    async listMessageEvents({ tenantId, messageId }) {
      // Fetch event timeline (all events, ordered chronologically)
      const eventsResult = await db.execute<SentLogEventRow>(sql`
        SELECT id, event_type, occurred_at, metadata, created_at
        FROM message_events
        WHERE message_id = ${messageId}::uuid
          AND tenant_id = ${tenantId}
        ORDER BY occurred_at ASC
        LIMIT 100
      `);
      return eventsResult.rows;
    },
  };
}
