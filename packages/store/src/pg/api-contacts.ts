/**
 * Postgres implementation of the queries used by packages/api/src/routes/contacts.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  ApiContactsQueries,
  ContactListFilter,
  ContactListRow,
  ContactListSort,
  ContactNoteRow,
} from "../areas/api-contacts.js";
import { listContactTopicStatuses } from "./contact-topics.js";
import { audienceCondition } from "../shared/audience.js";
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

/** The name the People list shows and sorts by: name, else email, else external id. */
const DISPLAY_NAME = sql`coalesce(nullif(trim(name), ''), email, external_id)`;

/** Lowercased first character of the display name (see ContactListFilter.letter). */
const INITIAL = sql`lower(substr(${DISPLAY_NAME}, 1, 1))`;

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/** The sort key expressions (ContactListSort); never null. */
function sortExpr(key: ContactListSort["key"]): SQL {
  switch (key) {
    case "created":
      return sql`created_at`;
    case "name":
      // Byte order, as SQLite's BINARY collation, so both backends agree.
      return sql`(lower(${DISPLAY_NAME}) COLLATE "C")`;
    case "joined":
      return sql`coalesce(first_seen_at, created_at)`;
    case "last_seen":
      return sql`coalesce(last_seen_at, 'epoch'::timestamptz)`;
  }
}

/** A cursor key as a bound value of the sort key's type. */
function cursorValue(key: ContactListSort["key"], value: string | number): SQL {
  if (key === "name") return sql`(${String(value)}::text COLLATE "C")`;
  const iso = typeof value === "number" ? new Date(value).toISOString() : value;
  return sql`${iso}::timestamptz`;
}

/** The People list filter as WHERE conditions (without the cursor). */
function listConditions(tenantId: string, filter: ContactListFilter, withLetter = true): SQL[] {
  const c: SQL[] = [sql`tenant_id = ${tenantId}`];
  if (filter.lifecycleState !== null) c.push(sql`lifecycle_state = ${filter.lifecycleState}`);
  if (filter.engagementDepth !== null) c.push(sql`engagement_depth = ${filter.engagementDepth}`);
  if (filter.paymentStatus !== null) c.push(sql`payment_status = ${filter.paymentStatus}`);
  if (filter.searchPattern !== null) {
    const p = filter.searchPattern;
    c.push(sql`(email ILIKE ${p} OR name ILIKE ${p} OR external_id ILIKE ${p})`);
  }
  if (withLetter && filter.letter !== null) {
    c.push(
      filter.letter === "#"
        ? sql`${INITIAL} NOT IN (${sql.join(LETTERS.map((l) => sql`${l}`), sql`, `)})`
        : sql`${INITIAL} = ${filter.letter}`,
    );
  }
  if (filter.tenureMinDays !== null) {
    c.push(sql`first_seen_at <= now() - make_interval(days => ${filter.tenureMinDays}::int)`);
  }
  if (filter.tenureMaxDays !== null) {
    c.push(sql`first_seen_at > now() - make_interval(days => ${filter.tenureMaxDays}::int)`);
  }
  if (filter.recencyMinDays !== null) {
    c.push(sql`last_seen_at <= now() - make_interval(days => ${filter.recencyMinDays}::int)`);
  }
  if (filter.recencyMaxDays !== null) {
    c.push(sql`last_seen_at > now() - make_interval(days => ${filter.recencyMaxDays}::int)`);
  }
  if (filter.joinedAfter !== null) {
    c.push(sql`coalesce(first_seen_at, created_at) >= ${filter.joinedAfter}::timestamptz`);
  }
  if (filter.joinedBefore !== null) {
    c.push(sql`coalesce(first_seen_at, created_at) < ${filter.joinedBefore}::timestamptz`);
  }
  if (filter.lastSeenAfter !== null) c.push(sql`last_seen_at >= ${filter.lastSeenAfter}::timestamptz`);
  if (filter.lastSeenBefore !== null) c.push(sql`last_seen_at < ${filter.lastSeenBefore}::timestamptz`);
  const audience = audienceCondition(filter.audience);
  if (audience !== null) c.push(audience);
  return c;
}

export function pgApiContacts(db: PgDb): ApiContactsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const tenantRows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return tenantRows.rows[0]?.settings ?? null;
    },

    async listContacts({ tenantId, filter, sort, after, limit }) {
      const key = sortExpr(sort.key);
      const conditions = listConditions(tenantId, filter);
      if (after) {
        const cmp = sort.order === "desc" ? sql`<` : sql`>`;
        conditions.push(sql`ROW(${key}, id) ${cmp} ROW(${cursorValue(sort.key, after.key)}, ${after.id}::uuid)`);
      }
      const dir = sort.order === "desc" ? sql`DESC` : sql`ASC`;
      return (
        await db.execute<ContactListRow>(sql`
          SELECT id, tenant_id, external_id, email, name, company,
                 lifecycle_state, engagement_depth, payment_status,
                 first_seen_at, last_seen_at, created_at,
                 ${key}::text AS sort_key
          FROM contacts
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY ${key} ${dir}, id ${dir}
          LIMIT ${limit}
        `)
      ).rows;
    },

    async countContactsByInitial({ tenantId, filter }) {
      const rows = (
        await db.execute<{ initial: string; n: string | number }>(sql`
          SELECT ${INITIAL} AS initial, count(*) AS n
          FROM contacts
          WHERE ${sql.join(listConditions(tenantId, filter, false), sql` AND `)}
          GROUP BY 1
        `)
      ).rows;
      return rows.map((r) => ({ initial: r.initial, n: Number(r.n) }));
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

    async findContactByEmail({ tenantId, email }) {
      const res = await db.execute<{ id: string; external_id: string; email: string | null }>(sql`
        SELECT id, external_id, email FROM contacts
        WHERE tenant_id = ${tenantId}::uuid AND lower(email) = lower(${email})
        ORDER BY created_at, id
        LIMIT 1
      `);
      const row = res.rows[0];
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
