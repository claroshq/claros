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
import type { ApiMessagesQueries, MessageListRow, OpenMessageCount } from "../areas/api-messages.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";

const ID_CHUNK = 90;

const LIST_COLUMNS = sql.raw(`
  m.id, m.tenant_id, m.contact_id, m.flow_id, m.flow_step_order,
  m.status, m.subject, m.body_html, m.body_text,
  m.brain_reasoning, m.brain_action_type, m.created_at, m.updated_at,
  m.scheduled_send_at, m.status_reason,
  m.approved_by, m.rejected_by, m.edited_by, m.edited_at,
  m.original_subject, m.original_body_html, m.original_body_text, m.forced_action_type,
  m.context_snapshot, m.choose_decision, m.opening_line, m.kb_entry_id, m.imported,
  m.revision_request, m.revisions,
  f.name AS flow_name, f.flow_class,
  c.email AS contact_email, c.name AS contact_name,
  c.external_id AS contact_external_id
`);

const toDate = (v: unknown): Date | null => (v == null ? null : new Date(Number(v)));

type MessageSet = Partial<Record<keyof typeof lifecycleMessages.$inferInsert, unknown>>;

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** A list query row with D1 values converted (ms timestamps to Date, JSON text parsed). */
function listRow(r: Record<string, unknown>): MessageListRow {
  return {
    ...r,
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
    scheduled_send_at: toDate(r.scheduled_send_at),
    edited_at: toDate(r.edited_at),
    context_snapshot: parseJson(r.context_snapshot),
    choose_decision: parseJson(r.choose_decision),
    revisions: parseJson(r.revisions),
    imported: r.imported === 1 || r.imported === true,
  } as MessageListRow;
}

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
        SELECT ${LIST_COLUMNS}
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
      return rows.map(listRow);
    },

    async getMessage({ tenantId, messageId }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT ${LIST_COLUMNS}, m.approved_at
        FROM lifecycle_messages m
        LEFT JOIN contacts c
          ON c.id = m.contact_id AND c.tenant_id = m.tenant_id
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND m.id = ${messageId.toLowerCase()}
      `);
      const r = rows[0];
      return r ? { ...listRow(r), approved_at: toDate(r.approved_at) } : null;
    },

    async countOpenMessages({ tenantId, since }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT m.flow_id, f.flow_class, m.status,
               CASE
                 WHEN m.status = 'pending_generation' AND m.status_reason = 'llm_budget' THEN 'llm_budget'
                 WHEN m.status = 'failed' THEN 'generation_failed'
               END AS reason,
               count(*) AS n,
               min(m.created_at) AS oldest_created_at
        FROM lifecycle_messages m
        LEFT JOIN flows f
          ON f.id = m.flow_id AND f.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}
          AND (
            m.status IN ('pending_approval', 'approved', 'pending_generation')
            OR (m.status = 'value_gated' AND m.created_at >= ${since.getTime()})
            OR (m.status = 'failed' AND m.brain_reasoning LIKE 'generation_failed:%' AND m.created_at >= ${since.getTime()})
          )
        GROUP BY 1, 2, 3, 4
      `);
      return rows.map((r): OpenMessageCount => ({
        flow_id: String(r.flow_id),
        flow_class: (r.flow_class as string | null) ?? null,
        status: String(r.status),
        reason: (r.reason as string | null) ?? null,
        n: Number(r.n),
        oldest_created_at: toDate(r.oldest_created_at),
      }));
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

    async regenerateMessage({ tenantId, messageId, actionType, revision, now }) {
      const moved = await transition(
        tenantId,
        [messageId],
        "pending_approval",
        {
          status: "pending_generation",
          ...(actionType ? { brainActionType: actionType, forcedActionType: actionType } : revision ? {} : { forcedActionType: null }),
          ...(revision
            ? {
                revisionRequest: revision.instruction,
                revisions: sql`json_insert(COALESCE(revisions, '[]'), '$[#]', json(${JSON.stringify(revision)}))`,
              }
            : { revisionRequest: null }),
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

    async releaseValueGated({ tenantId, messageId, now, outbox }) {
      const moved = await transition(
        tenantId,
        [messageId],
        "value_gated",
        {
          status: "pending_approval",
          // brain_reasoning is 'value_gated: <reason>'; 'value_gated: ' is 13 characters.
          statusReason: sql`'value_gate: ' || substr(COALESCE(brain_reasoning, ''), 14)`,
          updatedAt: now,
        },
        now,
        () => outbox,
      );
      return moved.length > 0;
    },

    async dismissValueGated({ tenantId, messageId, actor, now }) {
      const moved = await transition(tenantId, [messageId], "value_gated", { status: "cancelled", statusReason: "dismissed", rejectedBy: actor, updatedAt: now }, now, null);
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
