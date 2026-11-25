/**
 * Postgres implementation of the queries used by packages/api/src/routes/messages.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiMessagesQueries, MessageListRow } from "../areas/api-messages.js";

export function pgApiMessages(db: PgDb): ApiMessagesQueries {
  return {
    async listMessages({ tenantId, status: statusFilter, after: cursor, limit: fetchLimit }) {
      if (cursor) {
        const result = await db.execute<MessageListRow>(sql`
          SELECT m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
                 m.status, m.subject, m.body_html, m.body_text,
                 m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
                 m.scheduled_send_at,
                 c.email AS contact_email, c.name AS contact_name,
                 c.external_id AS contact_external_id
          FROM lifecycle_messages m
          LEFT JOIN contacts c
            ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
          WHERE m.tenant_id = ${tenantId}
            AND m.status = ${statusFilter}
            AND ROW(m.created_at, m.id) > ROW(${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT ${fetchLimit}
        `);
        return result.rows;
      }
      const result = await db.execute<MessageListRow>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
               m.status, m.subject, m.body_html, m.body_text,
               m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
               m.scheduled_send_at,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.status = ${statusFilter}
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${fetchLimit}
      `);
      return result.rows;
    },

    async approveMessages({ tenantId, ids, now }) {
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'approved', approved_at = ${now}, updated_at = ${now}
        WHERE tenant_id = ${tenantId}
          AND status = 'pending_approval'
          AND id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
        RETURNING id
      `);
      return casResult.rows.map((r) => r.id);
    },

    async rejectMessages({ tenantId, ids, now }) {
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'rejected', updated_at = ${now}
        WHERE tenant_id = ${tenantId}
          AND status = 'pending_approval'
          AND id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
        RETURNING id
      `);
      return casResult.rows.map((r) => r.id);
    },

    async approveMessage({ tenantId, messageId, now }) {
      // Attempt CAS: pending_approval -> approved
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'approved', approved_at = ${now}, updated_at = ${now}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'pending_approval'
        RETURNING id
      `);
      return casResult.rows.length > 0;
    },

    async rejectMessage({ tenantId, messageId, now }) {
      // Attempt CAS: pending_approval -> rejected
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'rejected', updated_at = ${now}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'pending_approval'
        RETURNING id
      `);
      return casResult.rows.length > 0;
    },

    async requeueFailedGeneration({ tenantId, messageId, now }) {
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_generation', retry_count = 0, updated_at = ${now}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'failed'
          AND brain_reasoning LIKE 'generation_failed:%'
        RETURNING id
      `);
      return casResult.rows.length > 0;
    },

    async getMessageStatus({ tenantId, messageId }) {
      const existing = await db.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM lifecycle_messages
        WHERE id = ${messageId} AND tenant_id = ${tenantId}
      `);
      return existing.rows.length > 0 ? existing.rows[0]!.status : null;
    },
  };
}
