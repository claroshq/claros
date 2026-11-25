/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-messages.ts.
 *
 * - listMessages: same raw SELECT as Postgres; timestamps come back as integer
 *   ms and are converted to Date (node-postgres returns Date for timestamptz).
 *   The keyset cursor is a row-value comparison on (rank, created_at ms, id).
 * - State transitions are CAS updates (UPDATE ... WHERE status = ? RETURNING id),
 *   atomic on SQLite. Without outbox entries the many-id variants chunk the
 *   id list under D1's bound-parameter limit; with them, each id gets its own
 *   update followed by its outbox inserts guarded by changes(), all in one
 *   batch (all or nothing), so only ids that transitioned get an event.
 */
import { sql, and, eq, inArray } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiMessagesQueries, MessageListRow } from "../areas/api-messages.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";

const ID_CHUNK = 90;

const toDate = (v: unknown): Date | null => (v == null ? null : new Date(Number(v)));

type MessageSet = Partial<Record<keyof typeof lifecycleMessages.$inferInsert, unknown>>;

export function d1ApiMessages(db: D1Db): ApiMessagesQueries {
  async function transition(
    tenantId: string,
    ids: string[],
    from: string,
    set: MessageSet,
    now: Date,
    outboxFor: ((id: string) => OutboxEntry[]) | null,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const update = (chunk: string[]) =>
      db
        .update(lifecycleMessages)
        .set(set as never)
        .where(
          and(
            eq(lifecycleMessages.tenantId, tenantId),
            eq(lifecycleMessages.status, from),
            inArray(lifecycleMessages.id, chunk),
          ),
        )
        .returning({ id: lifecycleMessages.id });

    const endpoints = outboxFor ? await d1OutboxEndpoints(db, tenantId, outboxFor(ids[0]!)) : [];
    const statements: unknown[] = [];
    const isUpdate: boolean[] = [];
    if (endpoints.length === 0) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        statements.push(update(ids.slice(i, i + ID_CHUNK)));
        isUpdate.push(true);
      }
    } else {
      for (const id of ids) {
        statements.push(update([id]));
        isUpdate.push(true);
        for (const st of d1OutboxInserts(db, tenantId, endpoints, outboxFor!(id), now, { afterChange: true })) {
          statements.push(st);
          isUpdate.push(false);
        }
      }
    }
    const results = (await db.batch(statements as never)) as unknown[];
    return results.flatMap((rows, i) => (isUpdate[i] ? (rows as Array<{ id: string }>).map((r) => r.id) : []));
  }

  const approvedEvent = (id: string): OutboxEntry[] => [{ event: "message.approved", payload: { message_id: id, decision: "approved" } }];
  const rejectedEvent = (id: string): OutboxEntry[] => [{ event: "message.rejected", payload: { message_id: id, decision: "rejected" } }];
  const m = lifecycleMessages;

  return {
    async listMessages({ tenantId, status, after, limit }) {
      const rank = sql`(CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END)`;
      const cursorCondition = after
        ? sql`AND (${rank}, m.created_at, m.id) > (${after.rank ?? 1}, ${new Date(after.createdAt).getTime()}, ${after.id})`
        : sql``;
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
               m.status, m.subject, m.body_html, m.body_text,
               m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
               m.scheduled_send_at, m.status_reason,
               m.approved_by, m.rejected_by, m.edited_by, m.edited_at,
               m.original_subject, m.original_body_html, m.original_body_text, m.forced_action_type,
               f.name AS flow_name, f.flow_class,
               c.email AS contact_email, c.name AS contact_name,
               c.external_id AS contact_external_id
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.status = ${status}
          ${cursorCondition}
        ORDER BY ${rank} ASC, m.created_at IS NULL, m.created_at ASC, m.id ASC
        LIMIT ${limit}
      `);
      return rows.map((r) => ({
        ...r,
        created_at: toDate(r.created_at),
        updated_at: toDate(r.updated_at),
        scheduled_send_at: toDate(r.scheduled_send_at),
        edited_at: toDate(r.edited_at),
      })) as MessageListRow[];
    },

    async approveMessages({ tenantId, ids, now, actor }) {
      return transition(tenantId, ids, "pending_approval", { status: "approved", approvedAt: now, approvedBy: actor ?? null, updatedAt: now }, now, approvedEvent);
    },

    async rejectMessages({ tenantId, ids, now, actor }) {
      return transition(tenantId, ids, "pending_approval", { status: "rejected", rejectedBy: actor ?? null, updatedAt: now }, now, rejectedEvent);
    },

    async approveMessage({ tenantId, messageId, now, actor }) {
      const moved = await transition(tenantId, [messageId], "pending_approval", { status: "approved", approvedAt: now, approvedBy: actor ?? null, updatedAt: now }, now, approvedEvent);
      return moved.length > 0;
    },

    async rejectMessage({ tenantId, messageId, now, actor }) {
      const moved = await transition(tenantId, [messageId], "pending_approval", { status: "rejected", rejectedBy: actor ?? null, updatedAt: now }, now, rejectedEvent);
      return moved.length > 0;
    },

    async editMessage({ tenantId, messageId, subject, bodyHtml, bodyText, actor, now }) {
      const moved = await transition(
        tenantId,
        [messageId],
        "pending_approval",
        {
          originalSubject: sql`CASE WHEN ${m.editedAt} IS NULL THEN ${m.subject} ELSE ${m.originalSubject} END`,
          originalBodyHtml: sql`CASE WHEN ${m.editedAt} IS NULL THEN ${m.bodyHtml} ELSE ${m.originalBodyHtml} END`,
          originalBodyText: sql`CASE WHEN ${m.editedAt} IS NULL THEN ${m.bodyText} ELSE ${m.originalBodyText} END`,
          subject,
          bodyHtml,
          bodyText,
          editedBy: actor,
          editedAt: now,
          updatedAt: now,
        },
        now,
        null,
      );
      return moved.length > 0;
    },

    async regenerateMessage({ tenantId, messageId, actionType, now }) {
      const moved = await transition(
        tenantId,
        [messageId],
        "pending_approval",
        {
          status: "pending_generation",
          ...(actionType ? { brainActionType: actionType, forcedActionType: actionType } : { forcedActionType: null }),
          retryCount: 0,
          statusReason: null,
          editedBy: null,
          editedAt: null,
          originalSubject: null,
          originalBodyHtml: null,
          originalBodyText: null,
          updatedAt: now,
        },
        now,
        null,
      );
      return moved.length > 0;
    },

    async cancelMessage({ tenantId, messageId, actor, now }) {
      const moved = await transition(tenantId, [messageId], "approved", { status: "cancelled", statusReason: "cancelled", rejectedBy: actor, updatedAt: now }, now, null);
      return moved.length > 0;
    },

    async unapproveMessage({ tenantId, messageId, now, outbox }) {
      const moved = await transition(tenantId, [messageId], "approved", { status: "pending_approval", approvedAt: null, approvedBy: null, updatedAt: now }, now, () => outbox);
      return moved.length > 0;
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

    async getMessageContent({ tenantId, messageId }) {
      const rows = await db
        .select({ status: m.status, subject: m.subject, bodyHtml: m.bodyHtml, bodyText: m.bodyText })
        .from(m)
        .where(and(eq(m.id, messageId), eq(m.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getMessageStatus({ tenantId, messageId }) {
      const rows = await db.all<{ status: string }>(sql`
        SELECT status FROM lifecycle_messages WHERE id = ${messageId} AND tenant_id = ${tenantId}
      `);
      return rows[0]?.status ?? null;
    },
  };
}
