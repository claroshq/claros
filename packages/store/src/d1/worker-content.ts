/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-content.ts.
 *
 * claimContentBatch: Postgres uses FOR UPDATE SKIP LOCKED. Here the claim is one
 * UPDATE ... WHERE id IN (SELECT ... ORDER BY ... LIMIT ?) AND status = ? RETURNING
 * statement; a single SQLite statement is atomic and D1 serialises writes, so each
 * row goes to exactly one concurrent caller. The tenant list is bound as one JSON
 * array (json_each) so it never hits D1's 100 bound-parameter limit.
 *
 * Every CAS is a guarded UPDATE ... WHERE id = ? AND status = ? RETURNING id.
 */
import { and, eq, sql } from "drizzle-orm";
import { contacts, flows, flowMemberships, lifecycleMessages, templates, tenants, kbEntries } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
import { d1ContactConditions } from "./contact-conditions.js";
import type { WorkerContentKbEntry } from "../areas/worker-content.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";
import type {
  WorkerContentQueries,
  WorkerContentTemplateContact,
} from "../areas/worker-content.js";

/** Postgres `jsonb ->> 'key'` on a parsed object: text for scalars, JSON text for objects. */
function jsonText(props: unknown, key: string): string | null {
  if (props === null || typeof props !== "object" || Array.isArray(props)) return null;
  const v = (props as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function d1WorkerContent(db: D1Db): WorkerContentQueries {
  /** CAS on lifecycle_messages: set `values` where id = messageId and status = fromStatus. */
  async function cas(
    messageId: string,
    fromStatus: string,
    values: Partial<typeof lifecycleMessages.$inferInsert>,
    events?: { tenantId: string; outbox: OutboxEntry[] },
    now?: Date,
  ): Promise<boolean> {
    const update = db
      .update(lifecycleMessages)
      .set(values)
      .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, fromStatus)))
      .returning({ id: lifecycleMessages.id });
    if (!events || events.outbox.length === 0) return (await update).length > 0;
    const endpoints = await d1OutboxEndpoints(db, events.tenantId, events.outbox);
    const inserts = d1OutboxInserts(db, events.tenantId, endpoints, events.outbox, now ?? new Date(), { afterChange: true });
    const [updated] = (await db.batch([update, ...inserts] as never)) as unknown[][];
    return (updated ?? []).length > 0;
  }

  return {
    ...d1ContactConditions(db),

    async claimContentBatch({ now, limit, tenantIds }) {
      if (tenantIds.length === 0) return [];
      const rows = await db.all<{
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
        created_at: number | null;
      }>(sql`
        UPDATE lifecycle_messages
        SET status = 'generating', updated_at = ${now.getTime()}
        WHERE id IN (
            SELECT lm.id
            FROM lifecycle_messages lm
            WHERE lm.status = 'pending_generation'
              AND lm.tenant_id IN (SELECT value FROM json_each(${JSON.stringify(tenantIds)}))
            ORDER BY lm.created_at IS NULL ASC, lm.created_at ASC
            LIMIT ${limit}
          )
          AND status = 'pending_generation'
        RETURNING id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type,
          revision_request, subject, body_text, created_at
      `);
      // RETURNING order is unspecified in SQLite: restore oldest first.
      const ts = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
      rows.sort((a, b) => ts(a.created_at) - ts(b.created_at));
      return rows.map((row) => ({
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
      const rows = await db
        .selectDistinct({ tenantId: lifecycleMessages.tenantId })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.status, "pending_generation"));
      return rows.map((r) => r.tenantId);
    },

    markFailed(messageId, fromStatus, reasoning, now, events) {
      return cas(messageId, fromStatus, { status: "failed", brainReasoning: reasoning, updatedAt: now }, events, now);
    },

    markSkipped(messageId, reasoning, now) {
      return cas(messageId, "generating", { status: "skipped", brainReasoning: reasoning, updatedAt: now });
    },

    markAwaitingContent(messageId, reasoning, now) {
      return cas(messageId, "generating", { status: "awaiting_content", brainReasoning: reasoning, statusReason: sql`NULLIF(status_reason, 'llm_budget')` as unknown as string, updatedAt: now });
    },

    markValueGated(messageId, { subject, bodyHtml, bodyText }, reasoning, now) {
      return cas(messageId, "awaiting_content", {
        status: "value_gated",
        subject,
        bodyHtml,
        bodyText,
        brainReasoning: reasoning,
        updatedAt: now,
      });
    },

    completeDraft(messageId, status, { subject, bodyHtml, bodyText }, approvedAt, now, events) {
      return cas(messageId, "awaiting_content", {
        status,
        subject,
        bodyHtml,
        bodyText,
        approvedAt,
        revisionRequest: null,
        updatedAt: now,
      }, events, now);
    },

    completeTemplate(messageId, status, { subject, bodyHtml, bodyText }, approvedAt, reasoning, now, events) {
      return cas(messageId, "generating", {
        status,
        subject,
        bodyHtml,
        bodyText,
        approvedAt,
        brainReasoning: reasoning,
        revisionRequest: null,
        statusReason: sql`NULLIF(status_reason, 'llm_budget')` as unknown as string,
        updatedAt: now,
      }, events, now);
    },

    releaseForBudget(messageId, now) {
      return cas(messageId, "generating", { status: "pending_generation", statusReason: "llm_budget", updatedAt: now });
    },

    async getMembershipTriggerProperties({ tenantId, membershipId }) {
      const rows = await db
        .select({ p: flowMemberships.triggerProperties })
        .from(flowMemberships)
        .where(and(eq(flowMemberships.tenantId, tenantId), eq(flowMemberships.id, membershipId)))
        .limit(1);
      const p = rows[0]?.p;
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    },

    async getFlowApprovalMode(flowId) {
      const rows = await db
        .select({ approvalMode: flows.approvalMode })
        .from(flows)
        .where(eq(flows.id, flowId))
        .limit(1);
      return rows[0]?.approvalMode ?? null;
    },

    async getActiveTemplate(tenantId, slug) {
      const rows = await db
        .select({ subject: templates.subject, body_html: templates.bodyHtml, body_text: templates.bodyText })
        .from(templates)
        .where(and(eq(templates.tenantId, tenantId), eq(templates.slug, slug), eq(templates.isActive, true)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getTemplateContact(tenantId, contactId) {
      const rows = await db
        .select({ email: contacts.email, external_id: contacts.externalId, properties: contacts.properties })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const properties = (row.properties ?? null) as WorkerContentTemplateContact["properties"];
      return {
        first_name: jsonText(properties, "first_name"),
        last_name: jsonText(properties, "last_name"),
        email: row.email,
        external_id: row.external_id,
        properties,
      };
    },

    async getTenantName(tenantId) {
      const rows = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return rows[0]?.name ?? null;
    },

    async listKbCandidates({ tenantId, category, excludeUsedBy }) {
      const rows = await db
        .select({ id: kbEntries.id, title: kbEntries.title, content: kbEntries.content, tags: kbEntries.tags, createdAt: kbEntries.createdAt })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            eq(kbEntries.category, category),
            eq(kbEntries.isActive, true),
            excludeUsedBy
              ? sql`NOT EXISTS (
                  SELECT 1 FROM lifecycle_messages um
                  WHERE um.tenant_id = ${tenantId} AND um.contact_id = ${excludeUsedBy.contactId}
                    AND um.kb_entry_id = ${kbEntries.id} AND um.id <> ${excludeUsedBy.exceptMessageId}
                    AND um.status NOT IN ('failed', 'rejected', 'cancelled', 'skipped', 'value_gated', 'suppressed')
                )`
              : undefined,
          ),
        )
        .orderBy(kbEntries.createdAt, kbEntries.id);
      return rows as WorkerContentKbEntry[];
    },

    async listPinnedKb(tenantId) {
      const rows = await db
        .select({ id: kbEntries.id, title: kbEntries.title, content: kbEntries.content, tags: kbEntries.tags, createdAt: kbEntries.createdAt })
        .from(kbEntries)
        .where(and(eq(kbEntries.tenantId, tenantId), eq(kbEntries.pinned, true), eq(kbEntries.isActive, true)))
        .orderBy(kbEntries.createdAt, kbEntries.id);
      return rows as WorkerContentKbEntry[];
    },

    async markBlocked({ messageId, fromStatus, statusReason, reasoning, body, now }) {
      const rows = await db
        .update(lifecycleMessages)
        .set({
          status: "failed",
          statusReason,
          brainReasoning: reasoning,
          subject: body.subject,
          bodyHtml: body.bodyHtml,
          bodyText: body.bodyText,
          updatedAt: now,
        })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, fromStatus)))
        .returning({ id: lifecycleMessages.id });
      return rows.length > 0;
    },

    async getFlowTopicGate({ tenantId, contactId, flowId }) {
      const rows = await db.all<{ kind: string; default_subscribed: number | boolean; status: string | null }>(sql`
        SELECT t.kind, t.default_subscribed, ct.status
        FROM flows f
        JOIN topics t ON t.id = f.topic_id AND t.tenant_id = f.tenant_id
        LEFT JOIN contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = ${contactId}
        WHERE f.id = ${flowId} AND f.tenant_id = ${tenantId}
      `);
      const r = rows[0];
      return r ? { kind: r.kind, defaultSubscribed: r.default_subscribed === 1 || r.default_subscribed === true, status: r.status ?? null } : null;
    },

    async getRenderInfo({ tenantId, flowId }) {
      const t = await db
        .select({ slug: tenants.slug, name: tenants.name, settings: tenants.settings, locale: tenants.locale })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const f = await db
        .select({ slug: flows.slug, name: flows.name, flowClass: flows.flowClass })
        .from(flows)
        .where(and(eq(flows.id, flowId), eq(flows.tenantId, tenantId)))
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
      const update = db
        .update(lifecycleMessages)
        .set(Object.keys(set).length > 0 ? set : { updatedAt: new Date() })
        .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.tenantId, tenantId)));
      if (!events || events.outbox.length === 0) {
        await update;
        return;
      }
      const endpoints = await d1OutboxEndpoints(db, events.tenantId, events.outbox);
      await db.batch([update, ...d1OutboxInserts(db, events.tenantId, endpoints, events.outbox, new Date(), { afterChange: true })] as never);
    },

    async getFlowName(flowId) {
      const rows = await db.select({ name: flows.name }).from(flows).where(eq(flows.id, flowId)).limit(1);
      return rows[0]?.name ?? null;
    },
  };
}
