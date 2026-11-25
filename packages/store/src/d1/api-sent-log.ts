/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-sent-log.ts.
 *
 * Differences from the Postgres SQL, same results:
 * - ILIKE -> LIKE ... ESCAPE '\' (SQLite LIKE is case-insensitive for ASCII;
 *   Postgres ILIKE also folds non-ASCII letters, SQLite does not).
 * - Timestamps are integer ms: ISO filter and cursor values are parsed in JS
 *   (no offset = UTC, as the Postgres session) and bound as ms; result
 *   timestamps are converted back to Date.
 * - date_trunc('milliseconds', sent_at) is the identity on ms values.
 * - jsonb metadata is JSON text, parsed on read.
 */
import { sql, type SQL } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type {
  ApiSentLogQueries,
  SentLogRow,
  SentLogDetailRow,
  SentLogEventRow,
} from "../areas/api-sent-log.js";

/** Parse a timestamptz literal like Postgres with session TimeZone UTC; ms since epoch. */
function tsMs(value: string): number {
  let s = value.trim();
  // Date-time without an offset: Postgres reads it in the session zone (UTC),
  // JS would read it as local time.
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

function withDates<T>(row: Record<string, unknown>, cols: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) out[c] = toDate(row[c]);
  return out as T;
}

export function d1ApiSentLog(db: D1Db): ApiSentLogQueries {
  return {
    async listSentMessages({ tenantId, filter, limit }) {
      const conditions: SQL[] = [sql`m.tenant_id = ${tenantId}`];

      if (filter.status !== null) {
        conditions.push(sql`m.status = ${filter.status}`);
      } else {
        conditions.push(sql`m.status IN ('sending', 'sent', 'failed', 'suppressed')`);
      }
      if (filter.flowId !== null) {
        conditions.push(sql`m.flow_id = ${filter.flowId.toLowerCase()}`);
      }
      if (filter.recipient !== null) {
        const pattern = `%${filter.recipient}%`;
        conditions.push(sql`(
          m.recipient_address LIKE ${pattern} ESCAPE '\\'
          OR c.email LIKE ${pattern} ESCAPE '\\'
          OR c.name LIKE ${pattern} ESCAPE '\\'
        )`);
      }
      if (filter.from !== null) conditions.push(sql`m.sent_at >= ${tsMs(filter.from)}`);
      if (filter.to !== null) conditions.push(sql`m.sent_at <= ${tsMs(filter.to)}`);
      if (filter.feedback !== null) {
        if (filter.feedback === "opened") {
          conditions.push(sql`m.feedback IN ('opened', 'clicked')`);
        } else {
          conditions.push(sql`m.feedback = ${filter.feedback}`);
        }
      }
      if (filter.before !== null) {
        conditions.push(
          sql`(m.sent_at, m.id) < (${tsMs(filter.before.sentAt)}, ${filter.before.id.toLowerCase()})`,
        );
      }

      const rows = await db.all<Record<string, unknown>>(sql`
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
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
        LIMIT ${limit}
      `);
      return rows.map((r) => withDates<SentLogRow>(r, ["sent_at", "created_at"]));
    },

    async getSentMessage({ tenantId, messageId }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT m.id, m.tenant_id, m.contact_id, m.flow_id,
               f.name AS flow_name,
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
        WHERE m.id = ${messageId.toLowerCase()}
          AND m.tenant_id = ${tenantId}
      `);
      const row = rows[0];
      if (!row) return null;
      return withDates<SentLogDetailRow>(row, [
        "scheduled_send_at",
        "approved_at",
        "sent_at",
        "created_at",
        "updated_at",
      ]);
    },

    async listMessageEvents({ tenantId, messageId }) {
      const rows = await db.all<Record<string, unknown>>(sql`
        SELECT id, event_type, occurred_at, metadata, created_at
        FROM message_events
        WHERE message_id = ${messageId.toLowerCase()}
          AND tenant_id = ${tenantId}
        ORDER BY occurred_at ASC
        LIMIT 100
      `);
      return rows.map((r) => {
        const out = withDates<SentLogEventRow>(r, ["occurred_at", "created_at"]);
        out.metadata = parseJson(r.metadata);
        return out;
      });
    },
  };
}
