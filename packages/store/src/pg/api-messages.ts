/**
 * Postgres implementation of the queries used by packages/api/src/routes/messages.ts.
 *
 * State transitions are compare-and-swap UPDATEs; the ones that report an
 * event (approve, reject, unapprove) write their outbox rows in the same
 * transaction, for the ids that actually transitioned.
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiMessagesQueries, MessageListRow } from "../areas/api-messages.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { pgWriteOutbox } from "./outbox.js";

const LIST_COLUMNS = sql`
  m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
  m.status, m.subject, m.body_html, m.body_text,
  m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
  m.scheduled_send_at, m.status_reason,
  m.approved_by, m.rejected_by, m.edited_by, m.edited_at,
  m.original_subject, m.original_body_html, m.original_body_text, m.forced_action_type,
  m.context_snapshot, m.choose_decision, m.opening_line, m.kb_entry_id, m.imported,
  f.name AS flow_name, f.flow_class,
  c.email AS contact_email, c.name AS contact_name,
  c.external_id AS contact_external_id
`;

const RANK = sql`(CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END)`;

export function pgApiMessages(db: PgDb): ApiMessagesQueries {
  /** CAS many ids; with outbox entries per transitioned id, in one transaction. */
  async function transition(
    tenantId: string,
    ids: string[],
    from: string,
    set: SQL,
    now: Date,
    outboxFor: ((id: string) => OutboxEntry[]) | null,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const run = async (tx: PgDb) => {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET ${set}
        WHERE tenant_id = ${tenantId}
          AND status = ${from}
          AND id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
        RETURNING id
      `);
      const moved = res.rows.map((r) => r.id);
      if (outboxFor && moved.length > 0) {
        await pgWriteOutbox(tx, tenantId, moved.flatMap(outboxFor), now);
      }
      return moved;
    };
    if (!outboxFor) return run(db);
    return db.transaction(async (tx) => run(tx as unknown as PgDb));
  }

  const approvedEvent = (id: string): OutboxEntry[] => [{ event: "message.approved", payload: { message_id: id, decision: "approved" } }];
  const rejectedEvent = (id: string): OutboxEntry[] => [{ event: "message.rejected", payload: { message_id: id, decision: "rejected" } }];

  return {
    async listMessages({ tenantId, status: statusFilter, after: cursor, limit: fetchLimit }) {
      const cursorClause = cursor
        ? sql`AND ROW(${RANK}, m.created_at, m.id) > ROW(${cursor.rank ?? 1}::int, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const result = await db.execute<MessageListRow>(sql`
        SELECT ${LIST_COLUMNS}
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.status = ${statusFilter}
          ${cursorClause}
        ORDER BY ${RANK} ASC, m.created_at ASC, m.id ASC
        LIMIT ${fetchLimit}
      `);
      return result.rows;
    },

    async approveMessages({ tenantId, ids, now, actor }) {
      return transition(tenantId, ids, "pending_approval", sql`status = 'approved', approved_at = ${now}, approved_by = ${actor ?? null}, updated_at = ${now}`, now, approvedEvent);
    },

    async rejectMessages({ tenantId, ids, now, actor }) {
      return transition(tenantId, ids, "pending_approval", sql`status = 'rejected', rejected_by = ${actor ?? null}, updated_at = ${now}`, now, rejectedEvent);
    },

    async approveMessage({ tenantId, messageId, now, actor }) {
      const moved = await transition(tenantId, [messageId], "pending_approval", sql`status = 'approved', approved_at = ${now}, approved_by = ${actor ?? null}, updated_at = ${now}`, now, approvedEvent);
      return moved.length > 0;
    },

    async rejectMessage({ tenantId, messageId, now, actor }) {
      const moved = await transition(tenantId, [messageId], "pending_approval", sql`status = 'rejected', rejected_by = ${actor ?? null}, updated_at = ${now}`, now, rejectedEvent);
      return moved.length > 0;
    },

    async editMessage({ tenantId, messageId, subject, bodyHtml, bodyText, actor, now }) {
      const moved = await transition(
        tenantId,
        [messageId],
        "pending_approval",
        sql`original_subject = CASE WHEN edited_at IS NULL THEN subject ELSE original_subject END,
            original_body_html = CASE WHEN edited_at IS NULL THEN body_html ELSE original_body_html END,
            original_body_text = CASE WHEN edited_at IS NULL THEN body_text ELSE original_body_text END,
            subject = ${subject}, body_html = ${bodyHtml}, body_text = ${bodyText},
            edited_by = ${actor}, edited_at = ${now}, updated_at = ${now}`,
        now,
        null,
      );
      return moved.length > 0;
    },

    async regenerateMessage({ tenantId, messageId, actionType, now }) {
      const actionSet = actionType
        ? sql`brain_action_type = ${actionType}, forced_action_type = ${actionType},`
        : sql`forced_action_type = NULL,`;
      const moved = await transition(
        tenantId,
        [messageId],
        "pending_approval",
        sql`status = 'pending_generation', ${actionSet}
            retry_count = 0, status_reason = NULL,
            edited_by = NULL, edited_at = NULL,
            original_subject = NULL, original_body_html = NULL, original_body_text = NULL,
            updated_at = ${now}`,
        now,
        null,
      );
      return moved.length > 0;
    },

    async cancelMessage({ tenantId, messageId, actor, now }) {
      const moved = await transition(tenantId, [messageId], "approved", sql`status = 'cancelled', status_reason = 'cancelled', rejected_by = ${actor}, updated_at = ${now}`, now, null);
      return moved.length > 0;
    },

    async unapproveMessage({ tenantId, messageId, now, outbox }) {
      const moved = await transition(tenantId, [messageId], "approved", sql`status = 'pending_approval', approved_at = NULL, approved_by = NULL, updated_at = ${now}`, now, () => outbox);
      return moved.length > 0;
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

    async getMessageContent({ tenantId, messageId }) {
      const res = await db.execute<{ status: string; subject: string | null; body_html: string | null; body_text: string | null }>(sql`
        SELECT status, subject, body_html, body_text FROM lifecycle_messages
        WHERE id = ${messageId} AND tenant_id = ${tenantId}
      `);
      const r = res.rows[0];
      return r ? { status: r.status, subject: r.subject, bodyHtml: r.body_html, bodyText: r.body_text } : null;
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
