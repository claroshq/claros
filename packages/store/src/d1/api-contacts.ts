/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-contacts.ts.
 *
 * Differences from the Postgres SQL, same results:
 * - ILIKE -> LIKE ... ESCAPE '\' (SQLite LIKE is case-insensitive for ASCII;
 *   Postgres ILIKE also folds non-ASCII letters, SQLite does not).
 * - now() - make_interval(days => n) is computed in JS and bound as ms.
 * - Cursor timestamps (ISO text) are parsed in JS (no offset = UTC, as the
 *   Postgres session) and compared as ms with SQLite row values.
 * - The timeline's parenthesised UNION ALL branches (each with its own ORDER BY
 *   and LIMIT) become subqueries in FROM, which SQLite allows.
 * - Integer ms timestamps are returned as Date, JSON text columns parsed.
 * - The name sort key uses lower() (ASCII only in SQLite, Unicode in
 *   Postgres) and byte order (BINARY here, COLLATE "C" there).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { lifecycleMessages, suppressions } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type {
  ApiContactsQueries,
  ContactListFilter,
  ContactListRow,
  ContactListSort,
  ContactNoteRow,
} from "../areas/api-contacts.js";
import { listContactTopicStatuses } from "./contact-topics.js";
import { rawBatch } from "./raw-batch.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses a message has before it is handed to the drain (G20 cancel). */
const NOT_SENT = ["pending_generation", "generating", "awaiting_content", "pending_approval", "approved"];

const DAY_MS = 86_400_000;

type NoteRaw = {
  id: string;
  body: string;
  created_at: number;
  author_user_id: string | null;
  author_name: string | null;
  author_email: string | null;
};

function toNote(r: NoteRaw): ContactNoteRow {
  return {
    id: r.id,
    body: r.body,
    createdAt: new Date(Number(r.created_at)),
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    authorEmail: r.author_email,
  };
}

const NOTE_SELECT = sql`
  SELECT n.id, n.body, n.created_at, n.author_user_id,
         u.name AS author_name, u.email AS author_email
  FROM contact_notes n
  LEFT JOIN users u ON u.id = n.author_user_id
`;

/** Parse a timestamptz literal like Postgres with session TimeZone UTC; ms since epoch. */
function tsMs(value: string): number {
  let s = value.trim();
  if (/\d[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s)) s += "Z";
  const ms = Date.parse(s.replace(" ", "T"));
  if (Number.isNaN(ms)) throw new Error(`[store] invalid timestamp: ${value}`);
  return ms;
}

function toDate(v: unknown): Date | null {
  return v === null || v === undefined ? null : new Date(Number(v));
}

function parseJson(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : (v ?? null);
}

function convert<T>(row: Record<string, unknown>, dates: string[], json: string[] = []): T {
  const out: Record<string, unknown> = { ...row };
  for (const c of dates) out[c] = toDate(row[c]);
  for (const c of json) out[c] = parseJson(row[c]);
  return out as T;
}

/** The name the People list shows and sorts by: name, else email, else external id. */
const DISPLAY_NAME = sql`coalesce(nullif(trim(name), ''), email, external_id)`;

/** Lowercased first character of the display name (see ContactListFilter.letter). */
const INITIAL = sql`lower(substr(${DISPLAY_NAME}, 1, 1))`;

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/** The sort key expressions (ContactListSort); never null. Timestamps are ms. */
function sortExpr(key: ContactListSort["key"]): SQL {
  switch (key) {
    case "created":
      return sql`created_at`;
    case "name":
      return sql`lower(${DISPLAY_NAME})`;
    case "joined":
      return sql`coalesce(first_seen_at, created_at)`;
    case "last_seen":
      return sql`coalesce(last_seen_at, 0)`;
  }
}

/** A cursor key as a bound value of the sort key's type (timestamps as ms). */
function cursorValue(key: ContactListSort["key"], value: string | number): string | number {
  if (key === "name") return String(value);
  return typeof value === "number" ? value : tsMs(value);
}

/** The People list filter as WHERE conditions (without the cursor). */
function listConditions(tenantId: string, filter: ContactListFilter, withLetter = true): SQL[] {
  const now = Date.now();
  const ago = (days: number) => now - days * DAY_MS;
  const conditions: SQL[] = [sql`tenant_id = ${tenantId}`];
  if (filter.lifecycleState !== null) {
    conditions.push(sql`lifecycle_state = ${filter.lifecycleState}`);
  }
  if (filter.engagementDepth !== null) {
    conditions.push(sql`engagement_depth = ${filter.engagementDepth}`);
  }
  if (filter.paymentStatus !== null) {
    conditions.push(sql`payment_status = ${filter.paymentStatus}`);
  }
  if (filter.searchPattern !== null) {
    const p = filter.searchPattern;
    conditions.push(sql`(email LIKE ${p} ESCAPE '\\'
      OR name LIKE ${p} ESCAPE '\\'
      OR external_id LIKE ${p} ESCAPE '\\')`);
  }
  if (withLetter && filter.letter !== null) {
    conditions.push(
      filter.letter === "#"
        ? sql`${INITIAL} NOT IN (${sql.join(LETTERS.map((l) => sql`${l}`), sql`, `)})`
        : sql`${INITIAL} = ${filter.letter}`,
    );
  }
  if (filter.tenureMinDays !== null) {
    conditions.push(sql`first_seen_at <= ${ago(filter.tenureMinDays)}`);
  }
  if (filter.tenureMaxDays !== null) {
    conditions.push(sql`first_seen_at > ${ago(filter.tenureMaxDays)}`);
  }
  if (filter.recencyMinDays !== null) {
    conditions.push(sql`last_seen_at <= ${ago(filter.recencyMinDays)}`);
  }
  if (filter.recencyMaxDays !== null) {
    conditions.push(sql`last_seen_at > ${ago(filter.recencyMaxDays)}`);
  }
  if (filter.joinedAfter !== null) {
    conditions.push(sql`coalesce(first_seen_at, created_at) >= ${tsMs(filter.joinedAfter)}`);
  }
  if (filter.joinedBefore !== null) {
    conditions.push(sql`coalesce(first_seen_at, created_at) < ${tsMs(filter.joinedBefore)}`);
  }
  if (filter.lastSeenAfter !== null) {
    conditions.push(sql`last_seen_at >= ${tsMs(filter.lastSeenAfter)}`);
  }
  if (filter.lastSeenBefore !== null) {
    conditions.push(sql`last_seen_at < ${tsMs(filter.lastSeenBefore)}`);
  }
  return conditions;
}

export function d1ApiContacts(db: D1Db): ApiContactsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const rows = await db.all<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return parseJson(rows[0]?.settings);
    },

    async listContacts({ tenantId, filter, sort, after, limit }) {
      const key = sortExpr(sort.key);
      const conditions = listConditions(tenantId, filter);
      if (after) {
        const cmp = sort.order === "desc" ? sql`<` : sql`>`;
        conditions.push(
          sql`(${key}, id) ${cmp} (${cursorValue(sort.key, after.key)}, ${after.id.toLowerCase()})`,
        );
      }
      const dir = sort.order === "desc" ? sql`DESC` : sql`ASC`;
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, tenant_id, external_id, email, name, company,
               lifecycle_state, engagement_depth, payment_status,
               first_seen_at, last_seen_at, created_at,
               ${key} AS sort_key
        FROM contacts
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY ${key} ${dir}, id ${dir}
        LIMIT ${limit}
      `);
      return rows.map((r) => convert<ContactListRow>(r, ["first_seen_at", "last_seen_at", "created_at"]));
    },

    async countContactsByInitial({ tenantId, filter }) {
      const rows = await db.all<{ initial: string; n: number }>(sql`
        SELECT ${INITIAL} AS initial, count(*) AS n
        FROM contacts
        WHERE ${sql.join(listConditions(tenantId, filter, false), sql` AND `)}
        GROUP BY 1
      `);
      return rows.map((r) => ({ initial: String(r.initial), n: Number(r.n) }));
    },

    async getContact({ tenantId, contactId }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, tenant_id, external_id, email, name, company, properties,
               lifecycle_state, engagement_depth, payment_status,
               first_seen_at, last_seen_at, activated_at, created_at
        FROM contacts
        WHERE tenant_id = ${tenantId} AND id = ${contactId.toLowerCase()}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return convert<Record<string, unknown>>(
        row,
        ["first_seen_at", "last_seen_at", "activated_at", "created_at"],
        ["properties"],
      );
    },

    async listContactMemberships({ tenantId, contactId }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT m.id, m.flow_id, f.name AS flow_name, m.status, m.current_step,
               m.entered_at, m.completed_at, m.exited_at, m.exit_reason
        FROM flow_memberships m
        JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${contactId.toLowerCase()}
        ORDER BY m.entered_at DESC
      `);
      return rows.map((r) =>
        convert<Record<string, unknown>>(r, ["entered_at", "completed_at", "exited_at"]),
      );
    },

    async findSuppression({ tenantId, email }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, reason, source, created_at
        FROM suppressions
        WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
        LIMIT 1
      `);
      const row = rows[0];
      return row ? convert<Record<string, unknown>>(row, ["created_at"]) : null;
    },

    async contactExists({ tenantId, contactId }) {
      const rows = await db.all<{ id: string }>(sql`
        SELECT id FROM contacts
        WHERE tenant_id = ${tenantId} AND id = ${contactId.toLowerCase()}
        LIMIT 1
      `);
      return rows.length > 0;
    },

    async listContactTimeline({ tenantId, contactId, before: cursor, limit }) {
      const cid = contactId.toLowerCase();
      // DESC keyset: rows strictly older than the cursor, applied inside each
      // branch so the branch LIMIT cannot cut off rows a later page needs.
      const cur = cursor ? { at: tsMs(cursor.occurredAt), id: cursor.id.toLowerCase() } : null;
      const eventCursor = cur ? sql`AND (e."timestamp", e.id) < (${cur.at}, ${cur.id})` : sql``;
      const transitionCursor = cur
        ? sql`AND (t.transitioned_at, t.id) < (${cur.at}, ${cur.id})`
        : sql``;
      const messageCursor = cur
        ? sql`AND (COALESCE(m.sent_at, m.created_at), m.id) < (${cur.at}, ${cur.id})`
        : sql``;

      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT * FROM (
          SELECT * FROM (
            SELECT 'event' AS kind, e.id AS id, e."timestamp" AS occurred_at,
                   e.type AS event_type, e.event_name AS event_name, e.properties AS properties,
                   NULL AS from_state, NULL AS to_state,
                   NULL AS subject, NULL AS status,
                   NULL AS feedback, NULL AS flow_id,
                   NULL AS flow_name, NULL AS flow_step_order,
                   e.context AS context, NULL AS metadata
            FROM events e
            WHERE e.tenant_id = ${tenantId} AND e.contact_id = ${cid}
            ${eventCursor}
            ORDER BY e."timestamp" DESC, e.id DESC
            LIMIT ${limit}
          )
          UNION ALL
          SELECT * FROM (
            SELECT 'transition', t.id, t.transitioned_at,
                   NULL, NULL, NULL,
                   t.from_state, t.to_state,
                   NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, t.metadata
            FROM lifecycle_transitions t
            WHERE t.tenant_id = ${tenantId} AND t.contact_id = ${cid}
            ${transitionCursor}
            ORDER BY t.transitioned_at DESC, t.id DESC
            LIMIT ${limit}
          )
          UNION ALL
          SELECT * FROM (
            SELECT 'message', m.id, COALESCE(m.sent_at, m.created_at),
                   NULL, NULL, NULL,
                   NULL, NULL,
                   m.subject, m.status, m.feedback, m.flow_id, f.name, m.flow_step_order,
                   NULL, NULL
            FROM lifecycle_messages m
            JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
            WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${cid}
            ${messageCursor}
            ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
            LIMIT ${limit}
          )
        ) merged
        ORDER BY merged.occurred_at DESC, merged.id DESC
        LIMIT ${limit}
      `);
      return rows.map((r) =>
        convert<Record<string, unknown>>(r, ["occurred_at"], ["properties", "context", "metadata"]),
      );
    },

    listContactTopics({ tenantId, contactId }) {
      return listContactTopicStatuses(db, tenantId, contactId);
    },
  
    async findContactByRef({ tenantId, ref }) {
      type Row = { id: string; external_id: string; email: string | null };
      let rows = await db.all<Row>(sql`
        SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId} AND external_id = ${ref} LIMIT 1
      `);
      if (rows.length === 0 && UUID_RE.test(ref)) {
        rows = await db.all<Row>(sql`
          SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId} AND id = ${ref.toLowerCase()} LIMIT 1
        `);
      }
      const row = rows[0];
      return row ? { id: row.id, externalId: row.external_id, email: row.email } : null;
    },

    async eraseContact({ tenantId, contactId }) {
      // One batch: all deletes commit together (D1 batch is one transaction).
      const results = await rawBatch(db, [
        sql`DELETE FROM message_events WHERE tenant_id = ${tenantId} AND message_id IN (SELECT id FROM lifecycle_messages WHERE tenant_id = ${tenantId} AND contact_id = ${contactId})`,
        sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM flow_memberships WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM contact_topics WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM contact_dates WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM contact_notes WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM contact_conflicts WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM events WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}`,
        sql`DELETE FROM webhook_outbox WHERE tenant_id = ${tenantId} AND status = 'pending' AND json_extract(payload, '$.contact_id') = ${contactId}`,
        sql`DELETE FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId} RETURNING id`,
      ]);
      return (results[results.length - 1] ?? []).length > 0;
    },

    async excludeContact({ tenantId, contactId, email, now }) {
      const statements: unknown[] = [];
      const lower = email ? email.toLowerCase() : null;
      if (lower) {
        const entries = [{ event: "contact.suppressed", payload: { email: lower, reason: "manual", source: "admin", contact_id: contactId } }];
        const endpoints = await d1OutboxEndpoints(db, tenantId, entries);
        statements.push(
          db.insert(suppressions).select(sql`
            SELECT ${crypto.randomUUID()}, ${tenantId}, ${lower}, 'manual', 'admin', ${now.getTime()}
            WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = ${tenantId} AND lower(s.email) = ${lower})
          `).returning({ id: suppressions.id }),
          ...d1OutboxInserts(db, tenantId, endpoints, entries, now, { afterChange: true }),
        );
      }
      const cancelIndex = statements.length;
      statements.push(
        db
          .update(lifecycleMessages)
          .set({ status: "cancelled", statusReason: "excluded", updatedAt: now })
          .where(and(eq(lifecycleMessages.tenantId, tenantId), eq(lifecycleMessages.contactId, contactId), inArray(lifecycleMessages.status, NOT_SENT)))
          .returning({ id: lifecycleMessages.id }),
      );
      const results = (await db.batch(statements as never)) as unknown[][];
      return {
        suppressed: lower ? (results[0] ?? []).length > 0 : false,
        cancelled: (results[cancelIndex] ?? []).map((r) => (r as { id: string }).id),
      };
    },

    async listContactNotes({ tenantId, contactId }) {
      const rows = await db.all<NoteRaw>(sql`
        ${NOTE_SELECT}
        WHERE n.tenant_id = ${tenantId} AND n.contact_id = ${contactId.toLowerCase()}
        ORDER BY n.created_at DESC, n.id DESC
      `);
      return rows.map(toNote);
    },

    async addContactNote({ tenantId, contactId, authorUserId, body, now }) {
      // One guarded statement: the note is written only when the contact exists.
      const id = crypto.randomUUID();
      const inserted = await db.all<{ id: string }>(sql`
        INSERT INTO contact_notes (id, tenant_id, contact_id, author_user_id, body, created_at)
        SELECT ${id}, c.tenant_id, c.id, ${authorUserId}, ${body}, ${now.getTime()}
        FROM contacts c
        WHERE c.tenant_id = ${tenantId} AND c.id = ${contactId.toLowerCase()}
        RETURNING id
      `);
      if (inserted.length === 0) return null;
      const rows = await db.all<NoteRaw>(sql`${NOTE_SELECT} WHERE n.tenant_id = ${tenantId} AND n.id = ${id}`);
      return rows[0] ? toNote(rows[0]) : null;
    },

    async deleteContactNote({ tenantId, contactId, noteId }) {
      const rows = await db.all<{ id: string }>(sql`
        DELETE FROM contact_notes
        WHERE tenant_id = ${tenantId} AND contact_id = ${contactId.toLowerCase()} AND id = ${noteId.toLowerCase()}
        RETURNING id
      `);
      return rows.length > 0;
    },
  };
}
