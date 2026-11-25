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
import { contacts, flows, lifecycleMessages, templates, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";
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
        RETURNING id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type, forced_action_type, created_at
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
      }));
    },

    async listTenantsWithPendingGeneration() {
      const rows = await db
        .selectDistinct({ tenantId: lifecycleMessages.tenantId })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.status, "pending_generation"));
      return rows.map((r) => r.tenantId);
    },

    markFailed(messageId, fromStatus, reasoning, now) {
      return cas(messageId, fromStatus, { status: "failed", brainReasoning: reasoning, updatedAt: now });
    },

    markSkipped(messageId, reasoning, now) {
      return cas(messageId, "generating", { status: "skipped", brainReasoning: reasoning, updatedAt: now });
    },

    markAwaitingContent(messageId, reasoning, now) {
      return cas(messageId, "generating", { status: "awaiting_content", brainReasoning: reasoning, updatedAt: now });
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
        updatedAt: now,
      }, events, now);
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

    async getFlowName(flowId) {
      const rows = await db.select({ name: flows.name }).from(flows).where(eq(flows.id, flowId)).limit(1);
      return rows[0]?.name ?? null;
    },
  };
}
