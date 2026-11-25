/**
 * Postgres implementation of the queries used by packages/api/src/routes/contacts.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiContactsQueries, ContactListRow, ContactNoteRow } from "../areas/api-contacts.js";
import { listContactTopicStatuses } from "./contact-topics.js";
import { pgWriteOutbox } from "./outbox.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses a message has before it is handed to the drain (G20 cancel). */
const NOT_SENT = ["pending_generation", "generating", "awaiting_content", "pending_approval", "approved"];

type NoteRaw = {
  id: string;
  body: string;
  created_at: string | Date;
  author_user_id: string | null;
  author_name: string | null;
  author_email: string | null;
};

function toNote(r: NoteRaw): ContactNoteRow {
  return {
    id: r.id,
    body: r.body,
    createdAt: new Date(r.created_at),
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    authorEmail: r.author_email,
  };
}

export function pgApiContacts(db: PgDb): ApiContactsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const tenantRows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return tenantRows.rows[0]?.settings ?? null;
    },

    async listContacts({ tenantId, filter, limit }) {
      const state = filter.lifecycleState;
      const depth = filter.engagementDepth;
      const search = filter.searchPattern;
      const tenureMin = filter.tenureMinDays;
      const tenureMax = filter.tenureMaxDays;
      const recencyMin = filter.recencyMinDays;
      const recencyMax = filter.recencyMaxDays;
      // DESC keyset: newest contacts first. Rows strictly older than the cursor.
      const cursorClause = filter.before
        ? sql`AND ROW(created_at, id) < ROW(${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`
        : sql``;

      return (
        await db.execute<ContactListRow>(sql`
          SELECT id, tenant_id, external_id, email, name, company,
                 lifecycle_state, engagement_depth, payment_status,
                 last_seen_at, created_at
          FROM contacts
          WHERE tenant_id = ${tenantId}
            AND (${state}::text IS NULL OR lifecycle_state = ${state})
            AND (${depth}::text IS NULL OR engagement_depth = ${depth})
            AND (${search}::text IS NULL OR
                 email ILIKE ${search} OR
                 name ILIKE ${search} OR
                 external_id ILIKE ${search})
            AND (${tenureMin}::int IS NULL OR first_seen_at <= now() - make_interval(days => ${tenureMin}))
            AND (${tenureMax}::int IS NULL OR first_seen_at > now() - make_interval(days => ${tenureMax}))
            AND (${recencyMin}::int IS NULL OR last_seen_at <= now() - make_interval(days => ${recencyMin}))
            AND (${recencyMax}::int IS NULL OR last_seen_at > now() - make_interval(days => ${recencyMax}))
            ${cursorClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `)
      ).rows;
    },

    async getContact({ tenantId, contactId }) {
      const contactRows = (
        await db.execute<Record<string, unknown>>(sql`
          SELECT id, tenant_id, external_id, email, name, company, properties,
                 lifecycle_state, engagement_depth, payment_status,
                 first_seen_at, last_seen_at, activated_at, created_at
          FROM contacts
          WHERE tenant_id = ${tenantId} AND id = ${contactId}::uuid
          LIMIT 1
        `)
      ).rows;
      return contactRows[0] ?? null;
    },

    async listContactMemberships({ tenantId, contactId }) {
      return (
        await db.execute<Record<string, unknown>>(sql`
          SELECT m.id, m.flow_id, f.name AS flow_name, m.status, m.current_step,
                 m.entered_at, m.completed_at, m.exited_at, m.exit_reason
          FROM flow_memberships m
          JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
          WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${contactId}::uuid
          ORDER BY m.entered_at DESC
        `)
      ).rows;
    },

    async findSuppression({ tenantId, email }) {
      const supRows = (
        await db.execute<Record<string, unknown>>(sql`
          SELECT id, reason, source, created_at
          FROM suppressions
          WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
          LIMIT 1
        `)
      ).rows;
      return supRows[0] ?? null;
    },

    async contactExists({ tenantId, contactId }) {
      const exists = (
        await db.execute<{ id: string }>(sql`
          SELECT id FROM contacts
          WHERE tenant_id = ${tenantId} AND id = ${contactId}::uuid
          LIMIT 1
        `)
      ).rows;
      return exists.length > 0;
    },

    async listContactTimeline({ tenantId, contactId, before: cursor, limit: fetchLimit }) {
      // DESC keyset: rows strictly older than the cursor, applied inside each
      // branch so the branch LIMIT cannot cut off rows a later page needs.
      const eventCursor = cursor
        ? sql`AND ROW(e."timestamp", e.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const transitionCursor = cursor
        ? sql`AND ROW(t.transitioned_at, t.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const messageCursor = cursor
        ? sql`AND ROW(COALESCE(m.sent_at, m.created_at), m.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;

      return (
        await db.execute<Record<string, unknown>>(sql`
          SELECT * FROM (
            (
              SELECT 'event' AS kind, e.id, e."timestamp" AS occurred_at,
                     e.type AS event_type, e.event_name, e.properties,
                     NULL::text AS from_state, NULL::text AS to_state,
                     NULL::text AS subject, NULL::text AS status,
                     NULL::text AS feedback, NULL::uuid AS flow_id,
                     NULL::text AS flow_name, NULL::integer AS flow_step_order,
                     e.context, NULL::jsonb AS metadata
              FROM events e
              WHERE e.tenant_id = ${tenantId} AND e.contact_id = ${contactId}::uuid
              ${eventCursor}
              ORDER BY e."timestamp" DESC, e.id DESC
              LIMIT ${fetchLimit}
            )
            UNION ALL
            (
              SELECT 'transition', t.id, t.transitioned_at,
                     NULL, NULL, NULL,
                     t.from_state, t.to_state,
                     NULL, NULL, NULL, NULL, NULL, NULL,
                     NULL::jsonb, t.metadata
              FROM lifecycle_transitions t
              WHERE t.tenant_id = ${tenantId} AND t.contact_id = ${contactId}::uuid
              ${transitionCursor}
              ORDER BY t.transitioned_at DESC, t.id DESC
              LIMIT ${fetchLimit}
            )
            UNION ALL
            (
              SELECT 'message', m.id, COALESCE(m.sent_at, m.created_at),
                     NULL, NULL, NULL,
                     NULL, NULL,
                     m.subject, m.status, m.feedback, m.flow_id, f.name, m.flow_step_order,
                     NULL::jsonb, NULL::jsonb
              FROM lifecycle_messages m
              JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
              WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${contactId}::uuid
              ${messageCursor}
              ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
              LIMIT ${fetchLimit}
            )
          ) merged
          ORDER BY merged.occurred_at DESC, merged.id DESC
          LIMIT ${fetchLimit}
        `)
      ).rows;
    },

    listContactTopics({ tenantId, contactId }) {
      return listContactTopicStatuses(db, tenantId, contactId);
    },
  
    async findContactByRef({ tenantId, ref }) {
      const byExt = await db.execute<{ id: string; external_id: string; email: string | null }>(sql`
        SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId}::uuid AND external_id = ${ref} LIMIT 1
      `);
      let row = byExt.rows[0];
      if (!row && UUID_RE.test(ref)) {
        const byId = await db.execute<{ id: string; external_id: string; email: string | null }>(sql`
          SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId}::uuid AND id = ${ref}::uuid LIMIT 1
        `);
        row = byId.rows[0];
      }
      return row ? { id: row.id, externalId: row.external_id, email: row.email } : null;
    },

    async eraseContact({ tenantId, contactId }) {
      return db.transaction(async (tx) => {
        const t = sql`${tenantId}::uuid`;
        const c = sql`${contactId}::uuid`;
        await tx.execute(sql`DELETE FROM message_events WHERE tenant_id = ${t} AND message_id IN (SELECT id FROM lifecycle_messages WHERE tenant_id = ${t} AND contact_id = ${c})`);
        await tx.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM contact_topics WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM contact_dates WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM contact_notes WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM contact_conflicts WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM events WHERE tenant_id = ${t} AND contact_id = ${c}`);
        await tx.execute(sql`DELETE FROM webhook_outbox WHERE tenant_id = ${t} AND status = 'pending' AND payload->>'contact_id' = ${contactId}`);
        const deleted = await tx.execute(sql`DELETE FROM contacts WHERE tenant_id = ${t} AND id = ${c} RETURNING id`);
        return deleted.rows.length > 0;
      });
    },

    async excludeContact({ tenantId, contactId, email, now }) {
      return db.transaction(async (tx) => {
        let suppressed = false;
        if (email) {
          const ins = await tx.execute(sql`
            INSERT INTO suppressions (tenant_id, email, reason, source, created_at)
            VALUES (${tenantId}::uuid, ${email.toLowerCase()}, 'manual', 'admin', ${now})
            ON CONFLICT (tenant_id, lower(email)) DO NOTHING
            RETURNING id
          `);
          suppressed = ins.rows.length > 0;
          if (suppressed) {
            await pgWriteOutbox(tx as unknown as PgDb, tenantId, [
              { event: "contact.suppressed", payload: { email: email.toLowerCase(), reason: "manual", source: "admin", contact_id: contactId } },
            ], now);
          }
        }
        const statuses = sql.join(NOT_SENT.map((s) => sql`${s}`), sql`, `);
        const cancelled = await tx.execute<{ id: string }>(sql`
          UPDATE lifecycle_messages
          SET status = 'cancelled', status_reason = 'excluded', updated_at = ${now}
          WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND status IN (${statuses})
          RETURNING id
        `);
        return { suppressed, cancelled: cancelled.rows.map((r) => r.id) };
      });
    },

    async listContactNotes({ tenantId, contactId }) {
      if (!UUID_RE.test(contactId)) return [];
      const rows = await db.execute<NoteRaw>(sql`
        SELECT n.id, n.body, n.created_at, n.author_user_id,
               u.name AS author_name, u.email AS author_email
        FROM contact_notes n
        LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.tenant_id = ${tenantId}::uuid AND n.contact_id = ${contactId}::uuid
        ORDER BY n.created_at DESC, n.id DESC
      `);
      return rows.rows.map(toNote);
    },

    async addContactNote({ tenantId, contactId, authorUserId, body, now }) {
      if (!UUID_RE.test(contactId)) return null;
      const rows = await db.execute<NoteRaw>(sql`
        WITH inserted AS (
          INSERT INTO contact_notes (tenant_id, contact_id, author_user_id, body, created_at)
          SELECT ${tenantId}::uuid, c.id, ${authorUserId}::uuid, ${body}, ${now}
          FROM contacts c
          WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${contactId}::uuid
          RETURNING id, body, created_at, author_user_id
        )
        SELECT i.id, i.body, i.created_at, i.author_user_id,
               u.name AS author_name, u.email AS author_email
        FROM inserted i
        LEFT JOIN users u ON u.id = i.author_user_id
      `);
      const row = rows.rows[0];
      return row ? toNote(row) : null;
    },

    async deleteContactNote({ tenantId, contactId, noteId }) {
      if (!UUID_RE.test(contactId) || !UUID_RE.test(noteId)) return false;
      const rows = await db.execute(sql`
        DELETE FROM contact_notes
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND id = ${noteId}::uuid
        RETURNING id
      `);
      return rows.rows.length > 0;
    },
  };
}
