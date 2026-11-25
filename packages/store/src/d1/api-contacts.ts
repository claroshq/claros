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
 */
import { sql, type SQL } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { ApiContactsQueries, ContactListRow } from "../areas/api-contacts.js";

const DAY_MS = 86_400_000;

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

export function d1ApiContacts(db: D1Db): ApiContactsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const rows = await db.all<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return parseJson(rows[0]?.settings);
    },

    async listContacts({ tenantId, filter, limit }) {
      const now = Date.now();
      const ago = (days: number) => now - days * DAY_MS;
      const conditions: SQL[] = [sql`tenant_id = ${tenantId}`];
      if (filter.lifecycleState !== null) {
        conditions.push(sql`lifecycle_state = ${filter.lifecycleState}`);
      }
      if (filter.engagementDepth !== null) {
        conditions.push(sql`engagement_depth = ${filter.engagementDepth}`);
      }
      if (filter.searchPattern !== null) {
        const p = filter.searchPattern;
        conditions.push(sql`(email LIKE ${p} ESCAPE '\\'
          OR name LIKE ${p} ESCAPE '\\'
          OR external_id LIKE ${p} ESCAPE '\\')`);
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
      if (filter.before) {
        conditions.push(
          sql`(created_at, id) < (${tsMs(filter.before.createdAt)}, ${filter.before.id.toLowerCase()})`,
        );
      }

      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, tenant_id, external_id, email, name, company,
               lifecycle_state, engagement_depth, payment_status,
               last_seen_at, created_at
        FROM contacts
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `);
      return rows.map((r) => convert<ContactListRow>(r, ["last_seen_at", "created_at"]));
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
  };
}
