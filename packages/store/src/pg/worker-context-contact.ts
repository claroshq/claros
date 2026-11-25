/**
 * Postgres implementation of the queries used by packages/worker/src/context-contact.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerContextContactQueries,
  WorkerContextContactRow,
  WorkerPriorContactRow,
} from "../areas/worker-context-contact.js";

type ContactRow = Record<string, unknown> & WorkerContextContactRow;
type PriorContactRow = Record<string, unknown> & WorkerPriorContactRow;

export function pgWorkerContextContact(db: PgDb): WorkerContextContactQueries {
  return {
    async getContact({ tenantId, contactId }) {
      // Query 1: contact row
      const contactRows = await db.execute<ContactRow>(sql`
        SELECT
          name,
          email,
          company,
          properties,
          lifecycle_state,
          engagement_depth,
          payment_status,
          first_seen_at,
          last_seen_at
        FROM contacts
        WHERE id = ${contactId}
          AND tenant_id = ${tenantId}
      `);
      return contactRows.rows[0] ?? null;
    },

    async getPriorContactStats({ tenantId, contactId }) {
      // Query 2: prior contact history
      //
      // feedback is a single advancing column (NULL -> opened -> clicked, or
      // NULL -> clicked; terminals: bounced, complained). A message that advanced
      // from opened to clicked is stored as feedback = 'clicked' - it is no longer
      // 'opened'. Counting feedback = 'opened' alone therefore undercounts: every
      // message that was opened AND clicked would be missed.
      //
      // Correct definition:
      //   messages_opened: feedback IN ('opened', 'clicked')
      //     clicked implies opened (legal transition only via opened or direct skip
      //     to clicked when the open pixel was not fired, but the click itself is
      //     stronger engagement evidence than an open alone).
      //   messages_clicked: feedback = 'clicked'
      //
      // bounced and complained are NOT counted as opened: bounced = undelivered,
      // complained = spam report. Neither indicates the contact read the email.
      const priorRows = await db.execute<PriorContactRow>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')                           AS total_sent,
          COUNT(*) FILTER (WHERE feedback IN ('opened', 'clicked'))         AS messages_opened,
          COUNT(*) FILTER (WHERE feedback = 'clicked')                      AS messages_clicked,
          MAX(sent_at)   FILTER (WHERE status = 'sent')                     AS last_sent_at,
          (
            SELECT brain_action_type
            FROM lifecycle_messages lm2
            WHERE lm2.contact_id = ${contactId}
              AND lm2.tenant_id = ${tenantId}
              AND lm2.status = 'sent'
              AND lm2.sent_at IS NOT NULL
            ORDER BY lm2.sent_at DESC
            LIMIT 1
          )                                                    AS last_action_type
        FROM lifecycle_messages
        WHERE contact_id = ${contactId}
          AND tenant_id = ${tenantId}
      `);
      return priorRows.rows[0]!;
    },
  };
}
