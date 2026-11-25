/**
 * Postgres implementation of the queries used by packages/worker/src/drain.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { tenants, contacts, flows, lifecycleMessages, suppressions } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerDrainQueries } from "../areas/worker-drain.js";

export function pgWorkerDrain(db: PgDb): WorkerDrainQueries {
  return {
    /**
     * Uses a CTE with FOR UPDATE SKIP LOCKED to:
     *   1. Select eligible messages without blocking on rows another worker holds
     *   2. Atomically set their status to 'sending' in the same statement
     *
     * This guarantees two concurrent drain workers get completely disjoint sets.
     * The claim (status = 'sending') happens inside the same SQL statement as
     * the lock, so no window exists between fetch and claim.
     */
    async claimDrainBatch({ now, limit: globalLimit, tenantIds }) {
      // Build tenant filter for the IN clause.
      const tenantFilter = sql.join(tenantIds.map((id) => sql`${id}`), sql`, `);

      // Two-step approach:
      //   1. CTE: select + lock + claim (atomically set to 'sending')
      //   2. Re-select the claimed rows joined with flows for ordering
      //
      // The CTE guarantees disjoint sets across concurrent workers (SKIP LOCKED).
      // The final SELECT re-orders by the spec-mandated sort (critical first, then
      // priority, then FIFO). UPDATE RETURNING does not preserve CTE order, so
      // we must re-sort.
      const rows = await db.execute<{
        id: string;
        tenant_id: string;
        contact_id: string;
        flow_id: string;
        flow_step_order: number | null;
        subject: string | null;
        body_html: string | null;
        body_text: string | null;
        retry_count: number | null;
        flow_class: string;
        priority: number | null;
        created_at: string | Date | null;
      }>(sql`
        WITH candidates AS (
          SELECT lm.id
          FROM lifecycle_messages lm
          JOIN flows f ON f.id = lm.flow_id
          WHERE lm.status = 'approved'
            AND lm.tenant_id IN (${tenantFilter})
            AND (lm.scheduled_send_at IS NULL OR lm.scheduled_send_at <= ${now})
          ORDER BY
            CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END ASC,
            f.priority DESC,
            lm.created_at ASC
          LIMIT ${globalLimit}
          FOR UPDATE OF lm SKIP LOCKED
        ),
        claimed AS (
          UPDATE lifecycle_messages
          SET status = 'sending', updated_at = ${now}
          WHERE id IN (SELECT id FROM candidates)
          RETURNING id, tenant_id, contact_id, flow_id, flow_step_order,
                    subject, body_html, body_text, retry_count, created_at
        )
        SELECT
          c.id, c.tenant_id, c.contact_id, c.flow_id, c.flow_step_order,
          c.subject, c.body_html, c.body_text, c.retry_count,
          f.flow_class, f.priority, c.created_at
        FROM claimed c
        JOIN flows f ON f.id = c.flow_id
        ORDER BY
          CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END ASC,
          f.priority DESC,
          c.created_at ASC
      `);

      return rows.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        contactId: row.contact_id,
        flowId: row.flow_id,
        flowStepOrder: row.flow_step_order,
        subject: row.subject,
        bodyHtml: row.body_html,
        bodyText: row.body_text,
        retryCount: row.retry_count,
      }));
    },

    async listTenantsWithDueMessages(now) {
      // This is a cheap read-only query (no locks, no writes).
      const tenantRows = await db.execute<{ tenant_id: string }>(sql`
        SELECT DISTINCT tenant_id
        FROM lifecycle_messages
        WHERE status = 'approved'
          AND (scheduled_send_at IS NULL OR scheduled_send_at <= ${now})
      `);
      return tenantRows.rows.map((r) => r.tenant_id);
    },

    async getTransportDailyLimit(tenantId) {
      const transportRows = await db.execute<{ daily_limit: number | null }>(sql`
        SELECT daily_limit
        FROM transport_configs
        WHERE tenant_id = ${tenantId} AND is_active = true
        LIMIT 1
      `);
      return transportRows.rows[0]?.daily_limit ?? null;
    },

    async countSentSince(tenantId, since) {
      const countRows = await db.execute<{ cnt: string }>(sql`
        SELECT COUNT(*)::text AS cnt
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND status = 'sent'
          AND sent_at >= ${since}
      `);
      return parseInt(countRows.rows[0]?.cnt ?? "0", 10);
    },

    async releaseClaim(messageId, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({ status: "approved", updatedAt: now })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async deferClaim(messageId, sendAt, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({
          status: "approved",
          scheduledSendAt: sendAt,
          updatedAt: now,
        })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async markSuppressed(messageId, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({ status: "suppressed", updatedAt: now })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async setRecipientAddress(messageId, email, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({ recipientAddress: email, updatedAt: now })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async markSent(messageId, providerMessageId, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({
          status: "sent",
          sentAt: now,
          providerMessageId,
          updatedAt: now,
        })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async markFailed(messageId, now) {
      const updated = await db
        .update(lifecycleMessages)
        .set({ status: "failed", updatedAt: now })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
        .returning({ id: lifecycleMessages.id });
      return updated.length > 0;
    },

    async getContact(contactId) {
      const contactRow = await db
        .select({
          email: contacts.email,
          properties: contacts.properties,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      return contactRow[0] ?? null;
    },

    async isSuppressed(tenantId, email) {
      // Case-insensitive via functional index on lower(email).
      // The index uq_suppressions_tenant_email_lower is keyed on lower(email), so
      // the query must use lower() on both sides to hit the index.
      const suppressionRow = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.tenantId, tenantId),
            sql`lower(${suppressions.email}) = lower(${email})`,
          ),
        )
        .limit(1);
      return suppressionRow.length > 0;
    },

    async getFlowThrottleInfo(flowId) {
      const flowRow = await db
        .select({
          flowClass: flows.flowClass,
          compiledPlan: flows.compiledPlan,
        })
        .from(flows)
        .where(eq(flows.id, flowId))
        .limit(1);
      return flowRow[0] ?? null;
    },

    async getTenantSettings(tenantId) {
      const tenantRow = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRow.length > 0 ? tenantRow[0]!.settings : null;
    },

    async getRecentSends(contactId, since24h, since7d) {
      const recentSendsResult = await db.execute<{
        count_24h: string;
        count_7d: string;
        last_sent: string | Date | null;
      }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE sent_at >= ${since24h})::text AS count_24h,
          COUNT(*)::text AS count_7d,
          MAX(sent_at) AS last_sent
        FROM lifecycle_messages
        WHERE contact_id = ${contactId}
          AND status IN ('sending', 'sent')
          AND sent_at >= ${since7d}
      `);

      const rawLastSent = recentSendsResult.rows[0]?.last_sent ?? null;
      return {
        countLast24h: parseInt(recentSendsResult.rows[0]?.count_24h ?? "0", 10),
        countLast7d: parseInt(recentSendsResult.rows[0]?.count_7d ?? "0", 10),
        lastSentAt: rawLastSent !== null
          ? (rawLastSent instanceof Date ? rawLastSent : new Date(rawLastSent))
          : null,
      };
    },

    async getSender(tenantId) {
      // Look up the active transport config for from address.
      const configRow = await db.execute<{
        from_email: string;
        from_name: string | null;
      }>(sql`
        SELECT from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}
          AND is_active = true
        LIMIT 1
      `);
      if (configRow.rows.length === 0) return null;
      return {
        fromEmail: configRow.rows[0]!.from_email,
        fromName: configRow.rows[0]!.from_name,
      };
    },

    async getTenant(tenantId) {
      const tenantRow = await db
        .select({ name: tenants.name, settings: tenants.settings, publicHost: tenants.publicHost })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRow[0] ?? null;
    },
  };
}
