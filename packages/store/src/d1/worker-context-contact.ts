/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-contact.ts.
 *
 * Results keep the Postgres shapes: snake_case keys, Date timestamps, parsed
 * JSON properties and COUNT values as strings. COUNT(*) FILTER (...) becomes
 * COUNT(CASE WHEN ... THEN 1 END).
 */
import { and, eq, sql } from "drizzle-orm";
import { contacts } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type {
  WorkerContextContactQueries,
  WorkerContextContactRow,
} from "../areas/worker-context-contact.js";

export function d1WorkerContextContact(db: D1Db): WorkerContextContactQueries {
  return {
    async getContact({ tenantId, contactId }) {
      const rows = await db
        .select({
          name: contacts.name,
          email: contacts.email,
          company: contacts.company,
          properties: contacts.properties,
          lifecycle_state: contacts.lifecycleState,
          engagement_depth: contacts.engagementDepth,
          payment_status: contacts.paymentStatus,
          first_seen_at: contacts.firstSeenAt,
          last_seen_at: contacts.lastSeenAt,
        })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
      const row = rows[0];
      if (!row) return null;
      return { ...row, properties: (row.properties ?? null) as WorkerContextContactRow["properties"] };
    },

    async getPriorContactStats({ tenantId, contactId }) {
      const rows = await db.all<{
        total_sent: number;
        messages_opened: number;
        messages_clicked: number;
        last_sent_at: number | null;
        last_action_type: string | null;
      }>(sql`
        SELECT
          COUNT(CASE WHEN status = 'sent' THEN 1 END)                     AS total_sent,
          COUNT(CASE WHEN feedback IN ('opened', 'clicked') THEN 1 END)   AS messages_opened,
          COUNT(CASE WHEN feedback = 'clicked' THEN 1 END)                AS messages_clicked,
          MAX(CASE WHEN status = 'sent' THEN sent_at END)                 AS last_sent_at,
          (
            SELECT brain_action_type
            FROM lifecycle_messages lm2
            WHERE lm2.contact_id = ${contactId}
              AND lm2.tenant_id = ${tenantId}
              AND lm2.status = 'sent'
              AND lm2.sent_at IS NOT NULL
            ORDER BY lm2.sent_at DESC
            LIMIT 1
          )                                                               AS last_action_type
        FROM lifecycle_messages
        WHERE contact_id = ${contactId}
          AND tenant_id = ${tenantId}
      `);
      const r = rows[0]!;
      return {
        total_sent: String(r.total_sent),
        messages_opened: String(r.messages_opened),
        messages_clicked: String(r.messages_clicked),
        last_sent_at: r.last_sent_at === null ? null : new Date(Number(r.last_sent_at)),
        last_action_type: r.last_action_type,
      };
    },
  };
}
