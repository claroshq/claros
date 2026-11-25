/**
 * Postgres implementation of the queries used by packages/worker/src/content.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { pgWriteOutbox } from "./outbox.js";
import type {
  WorkerContentQueries,
  WorkerContentTemplate,
  WorkerContentTemplateContact,
} from "../areas/worker-content.js";

export function pgWorkerContent(db: PgDb): WorkerContentQueries {
  /** Run a CAS; with outbox entries, in a transaction that writes them when the CAS won. */
  async function withOutbox(
    events: { tenantId: string; outbox: OutboxEntry[] } | undefined,
    now: Date,
    cas: (tx: PgDb) => Promise<boolean>,
  ): Promise<boolean> {
    if (!events || events.outbox.length === 0) return cas(db);
    return db.transaction(async (tx) => {
      const won = await cas(tx as unknown as PgDb);
      if (won) await pgWriteOutbox(tx as unknown as PgDb, events.tenantId, events.outbox, now);
      return won;
    });
  }

  return {
    /**
     * Uses a CTE with FOR UPDATE SKIP LOCKED to:
     *   1. Select eligible messages without blocking on rows another worker holds
     *   2. Atomically set their status to 'generating' in the same statement
     *
     * This guarantees two concurrent content workers get completely disjoint sets.
     * The claim (status = 'generating') happens inside the same SQL statement as
     * the lock, so no window exists between fetch and claim.
     */
    async claimContentBatch({ now, limit: batchLimit, tenantIds }) {
      const tenantFilter = sql.join(tenantIds.map((id) => sql`${id}`), sql`, `);

      const rows = await db.execute<{
        id: string;
        tenant_id: string;
        contact_id: string;
        flow_id: string;
        membership_id: string;
        flow_step_order: number | null;
        brain_action_type: string | null;
        forced_action_type: string | null;
      }>(sql`
        WITH candidates AS (
          SELECT lm.id
          FROM lifecycle_messages lm
          WHERE lm.status = 'pending_generation'
            AND lm.tenant_id IN (${tenantFilter})
          ORDER BY lm.created_at ASC
          LIMIT ${batchLimit}
          FOR UPDATE OF lm SKIP LOCKED
        ),
        claimed AS (
          UPDATE lifecycle_messages
          SET status = 'generating', updated_at = ${now}
          WHERE id IN (SELECT id FROM candidates)
          RETURNING id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type
        )
        SELECT id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type
        FROM claimed
      `);

      return rows.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        contactId: row.contact_id,
        flowId: row.flow_id,
        membershipId: row.membership_id,
        flowStepOrder: row.flow_step_order,
        brainActionType: row.brain_action_type,
        forcedActionType: row.forced_action_type,
      }));
    },

    async listTenantsWithPendingGeneration() {
      const tenantRows = await db.execute<{ tenant_id: string }>(sql`
        SELECT DISTINCT tenant_id
        FROM lifecycle_messages
        WHERE status = 'pending_generation'
      `);
      return tenantRows.rows.map((r) => r.tenant_id);
    },

    async markFailed(messageId, fromStatus, reasoning, now) {
      const result = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'failed',
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = ${fromStatus}
        RETURNING id
      `);
      return result.rows.length > 0;
    },

    async markSkipped(messageId, reasoning, now) {
      const skipResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'skipped',
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'generating'
        RETURNING id
      `);
      return skipResult.rows.length > 0;
    },

    async markAwaitingContent(messageId, reasoning, now) {
      const awaitResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'awaiting_content',
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'generating'
        RETURNING id
      `);
      return awaitResult.rows.length > 0;
    },

    async markValueGated(messageId, { subject, bodyHtml, bodyText }, gateReasoning, now) {
      const gatedResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'value_gated',
          subject = ${subject},
          body_html = ${bodyHtml},
          body_text = ${bodyText},
          brain_reasoning = ${gateReasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'awaiting_content'
        RETURNING id
      `);
      return gatedResult.rows.length > 0;
    },

    async completeDraft(messageId, targetStatus, { subject, bodyHtml, bodyText }, approvedAt, now, events) {
      return withOutbox(events, now, async (tx) => (await tx.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = ${targetStatus},
          subject = ${subject},
          body_html = ${bodyHtml},
          body_text = ${bodyText},
          approved_at = ${approvedAt},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'awaiting_content'
        RETURNING id
      `)).rows.length > 0);
    },

    async completeTemplate(messageId, targetStatus, { subject, bodyHtml, bodyText }, approvedAt, reasoning, now, events) {
      return withOutbox(events, now, async (tx) => (await tx.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = ${targetStatus},
          subject = ${subject},
          body_html = ${bodyHtml},
          body_text = ${bodyText},
          approved_at = ${approvedAt},
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'generating'
        RETURNING id
      `)).rows.length > 0);
    },

    async getFlowApprovalMode(flowId) {
      const flowRow = await db.execute<{ approval_mode: string | null }>(sql`
        SELECT approval_mode FROM flows WHERE id = ${flowId}
      `);
      return flowRow.rows[0]?.approval_mode ?? null;
    },

    async getActiveTemplate(tenantId, slug) {
      const templateRow = await db.execute<WorkerContentTemplate & Record<string, unknown>>(sql`
        SELECT subject, body_html, body_text
        FROM templates
        WHERE tenant_id = ${tenantId}
          AND slug = ${slug}
          AND is_active = true
        LIMIT 1
      `);
      return templateRow.rows[0] ?? null;
    },

    async getTemplateContact(tenantId, contactId) {
      const contactRow = await db.execute<WorkerContentTemplateContact & Record<string, unknown>>(sql`
        SELECT
          properties->>'first_name' AS first_name,
          properties->>'last_name' AS last_name,
          email,
          external_id,
          properties
        FROM contacts
        WHERE id = ${contactId}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `);
      return contactRow.rows[0] ?? null;
    },

    async getTenantName(tenantId) {
      const tenantRow = await db.execute<{ name: string }>(sql`
        SELECT name FROM tenants WHERE id = ${tenantId} LIMIT 1
      `);
      return tenantRow.rows[0]?.name ?? null;
    },

    async getFlowName(flowId) {
      const flowRow = await db.execute<{ name: string }>(sql`
        SELECT name FROM flows WHERE id = ${flowId} LIMIT 1
      `);
      return flowRow.rows[0]?.name ?? null;
    },
  };
}
