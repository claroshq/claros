/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-messages.ts.
 *
 * - listMessages: same raw SELECT as Postgres; timestamps come back as integer
 *   ms and are converted to Date (node-postgres returns Date for timestamptz).
 *   The keyset cursor is a row-value comparison on (created_at ms, id).
 * - State transitions are CAS updates (UPDATE ... WHERE status = ? RETURNING id),
 *   atomic on SQLite. The many-id variants chunk the id list under D1's
 *   bound-parameter limit and run the chunks as one batch (all or nothing;
 *   builder queries, since Drizzle cannot batch raw sql on D1).
 */
import { sql, and, eq, inArray } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiMessagesQueries, MessageListRow } from "../areas/api-messages.js";

const ID_CHUNK = 90;

const toDate = (v: unknown): Date | null => (v == null ? null : new Date(Number(v)));

export function d1ApiMessages(db: D1Db): ApiMessagesQueries {
  async function casMany(
    tenantId: string,
    ids: string[],
    set: { status: string; approvedAt?: Date; updatedAt: Date },
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const statements = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      statements.push(
        db
          .update(lifecycleMessages)
          .set(set)
          .where(
            and(
              eq(lifecycleMessages.tenantId, tenantId),
              eq(lifecycleMessages.status, "pending_approval"),
              inArray(lifecycleMessages.id, ids.slice(i, i + ID_CHUNK)),
            ),
          )
          .returning({ id: lifecycleMessages.id }),
      );
    }
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return results.flatMap((rows) => rows.map((r) => r.id));
  }

  return {
    async listMessages({ tenantId, status, after, limit }) {
      const cursorCondition = after
        ? sql`AND (m.created_at, m.id) > (${new Date(after.createdAt).getTime()}, ${after.id})`
        : sql``;
      const rows = await db.all<Record<string, unknown>>(sql`
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
          AND m.status = ${status}
          ${cursorCondition}
        ORDER BY m.created_at IS NULL, m.created_at ASC, m.id ASC
        LIMIT ${limit}
      `);
      return rows.map((r) => ({
        ...r,
        created_at: toDate(r.created_at),
        updated_at: toDate(r.updated_at),
        scheduled_send_at: toDate(r.scheduled_send_at),
      })) as MessageListRow[];
    },

    async approveMessages({ tenantId, ids, now }) {
      return casMany(tenantId, ids, { status: "approved", approvedAt: now, updatedAt: now });
    },

    async rejectMessages({ tenantId, ids, now }) {
      return casMany(tenantId, ids, { status: "rejected", updatedAt: now });
    },

    async approveMessage({ tenantId, messageId, now }) {
      const ms = now.getTime();
      const rows = await db.all<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'approved', approved_at = ${ms}, updated_at = ${ms}
        WHERE id = ${messageId} AND tenant_id = ${tenantId} AND status = 'pending_approval'
        RETURNING id
      `);
      return rows.length > 0;
    },

    async rejectMessage({ tenantId, messageId, now }) {
      const rows = await db.all<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'rejected', updated_at = ${now.getTime()}
        WHERE id = ${messageId} AND tenant_id = ${tenantId} AND status = 'pending_approval'
        RETURNING id
      `);
      return rows.length > 0;
    },

    async requeueFailedGeneration({ tenantId, messageId, now }) {
      const rows = await db.all<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_generation', retry_count = 0, updated_at = ${now.getTime()}
        WHERE id = ${messageId}
          AND tenant_id = ${tenantId}
          AND status = 'failed'
          AND brain_reasoning LIKE 'generation_failed:%'
        RETURNING id
      `);
      return rows.length > 0;
    },

    async getMessageStatus({ tenantId, messageId }) {
      const rows = await db.all<{ status: string }>(sql`
        SELECT status FROM lifecycle_messages WHERE id = ${messageId} AND tenant_id = ${tenantId}
      `);
      return rows[0]?.status ?? null;
    },
  };
}
