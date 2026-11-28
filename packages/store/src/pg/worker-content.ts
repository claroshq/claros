/**
 * Postgres implementation of the queries used by packages/worker/src/content.ts.
 */
import { and, eq, sql } from "drizzle-orm";
import { flows as flowsT, lifecycleMessages as messagesT, tenants as tenantsT, kbEntries as kbT } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { pgContactConditions } from "./contact-conditions.js";
import type { WorkerContentKbEntry } from "../areas/worker-content.js";
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
    ...pgContactConditions(db),

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
        revision_request: string | null;
        subject: string | null;
        body_text: string | null;
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
          RETURNING id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type,
            revision_request, subject, body_text
        )
        SELECT id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type,
          revision_request, subject, body_text
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
        revisionRequest: row.revision_request,
        previousSubject: row.subject,
        previousBodyText: row.body_text,
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

    async markFailed(messageId, fromStatus, reasoning, now, events) {
      return withOutbox(events, now, async (tx) => (await tx.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'failed',
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = ${fromStatus}
        RETURNING id
      `)).rows.length > 0);
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
          status_reason = NULLIF(status_reason, 'llm_budget'),
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

    async completeDraft(messageId, targetStatus, { subject, bodyHtml, bodyText }, approvedAt, now, events, statusReason = null) {
      return withOutbox(events, now, async (tx) => (await tx.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = ${targetStatus},
          subject = ${subject},
          body_html = ${bodyHtml},
          body_text = ${bodyText},
          approved_at = ${approvedAt},
          revision_request = NULL,
          status_reason = ${statusReason},
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
          status_reason = NULLIF(status_reason, 'llm_budget'),
          revision_request = NULL,
          updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'generating'
        RETURNING id
      `)).rows.length > 0);
    },

    async releaseForBudget(messageId, now) {
      const res = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_generation', status_reason = 'llm_budget', updated_at = ${now}
        WHERE id = ${messageId} AND status = 'generating'
        RETURNING id
      `);
      return res.rows.length > 0;
    },

    async getMembershipTriggerProperties({ tenantId, membershipId }) {
      const res = await db.execute<{ p: Record<string, unknown> | null }>(sql`
        SELECT trigger_properties AS p FROM flow_memberships WHERE id = ${membershipId}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      const p = res.rows[0]?.p;
      return p && typeof p === "object" && !Array.isArray(p) ? p : null;
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

    async listKbCandidates({ tenantId, category, excludeUsedBy }) {
      const rows = await db
        .select({ id: kbT.id, title: kbT.title, content: kbT.content, tags: kbT.tags, createdAt: kbT.createdAt })
        .from(kbT)
        .where(
          and(
            eq(kbT.tenantId, tenantId),
            eq(kbT.category, category),
            eq(kbT.isActive, true),
            excludeUsedBy
              ? sql`NOT EXISTS (
                  SELECT 1 FROM lifecycle_messages um
                  WHERE um.tenant_id = ${tenantId} AND um.contact_id = ${excludeUsedBy.contactId}
                    AND um.kb_entry_id = ${kbT.id} AND um.id <> ${excludeUsedBy.exceptMessageId}
                    AND um.status NOT IN ('failed', 'rejected', 'cancelled', 'skipped', 'value_gated', 'suppressed')
                )`
              : undefined,
          ),
        )
        .orderBy(kbT.createdAt, kbT.id);
      return rows as WorkerContentKbEntry[];
    },

    async listPinnedKb(tenantId) {
      const rows = await db
        .select({ id: kbT.id, title: kbT.title, content: kbT.content, tags: kbT.tags, createdAt: kbT.createdAt })
        .from(kbT)
        .where(and(eq(kbT.tenantId, tenantId), eq(kbT.pinned, true), eq(kbT.isActive, true)))
        .orderBy(kbT.createdAt, kbT.id);
      return rows as WorkerContentKbEntry[];
    },

    async markBlocked({ messageId, fromStatus, statusReason, reasoning, body, now }) {
      const rows = await db
        .update(messagesT)
        .set({
          status: "failed",
          statusReason,
          brainReasoning: reasoning,
          subject: body.subject,
          bodyHtml: body.bodyHtml,
          bodyText: body.bodyText,
          updatedAt: now,
        })
        .where(and(eq(messagesT.id, messageId), eq(messagesT.status, fromStatus)))
        .returning({ id: messagesT.id });
      return rows.length > 0;
    },

    async getFlowTopicGate({ tenantId, contactId, flowId }) {
      const res = await db.execute<{ kind: string; default_subscribed: boolean; status: string | null }>(sql`
        SELECT t.kind, t.default_subscribed, ct.status
        FROM flows f
        JOIN topics t ON t.id = f.topic_id AND t.tenant_id = f.tenant_id
        LEFT JOIN contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = ${contactId}::uuid
        WHERE f.id = ${flowId}::uuid AND f.tenant_id = ${tenantId}::uuid
      `);
      const r = res.rows[0];
      return r ? { kind: r.kind, defaultSubscribed: Boolean(r.default_subscribed), status: r.status ?? null } : null;
    },

    async getRenderInfo({ tenantId, flowId }) {
      const t = await db
        .select({ slug: tenantsT.slug, name: tenantsT.name, settings: tenantsT.settings, locale: tenantsT.locale })
        .from(tenantsT)
        .where(eq(tenantsT.id, tenantId))
        .limit(1);
      const f = await db
        .select({ slug: flowsT.slug, name: flowsT.name, flowClass: flowsT.flowClass })
        .from(flowsT)
        .where(and(eq(flowsT.id, flowId), eq(flowsT.tenantId, tenantId)))
        .limit(1);
      if (!t[0] || !f[0]) return null;
      const settings = t[0].settings && typeof t[0].settings === "object" ? (t[0].settings as Record<string, unknown>) : {};
      return { tenantSlug: t[0].slug, tenantName: t[0].name, settings, locale: t[0].locale ?? null, flowSlug: f[0].slug ?? null, flowName: f[0].name, flowClass: f[0].flowClass ?? "nurture" };
    },

    async saveMessageMeta({ tenantId, messageId, meta, events }) {
      const set: Record<string, unknown> = {};
      if (meta.contextSnapshot !== undefined) set.contextSnapshot = meta.contextSnapshot;
      if (meta.chooseDecision !== undefined) set.chooseDecision = meta.chooseDecision;
      if (meta.openingLine !== undefined) set.openingLine = meta.openingLine;
      if (meta.kbEntryId !== undefined) set.kbEntryId = meta.kbEntryId;
      if (meta.actionType !== undefined) set.brainActionType = meta.actionType;
      if (Object.keys(set).length === 0 && !events) return;
      if (!events || events.outbox.length === 0) {
        await db.update(messagesT).set(set).where(and(eq(messagesT.id, messageId), eq(messagesT.tenantId, tenantId)));
        return;
      }
      await db.transaction(async (tx) => {
        if (Object.keys(set).length > 0) {
          await (tx as unknown as PgDb).update(messagesT).set(set).where(and(eq(messagesT.id, messageId), eq(messagesT.tenantId, tenantId)));
        }
        await pgWriteOutbox(tx as unknown as PgDb, events.tenantId, events.outbox, new Date());
      });
    },

    async getFlowName(flowId) {
      const flowRow = await db.execute<{ name: string }>(sql`
        SELECT name FROM flows WHERE id = ${flowId} LIMIT 1
      `);
      return flowRow.rows[0]?.name ?? null;
    },
  };
}
