/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-drain.ts.
 *
 * claimDrainBatch: Postgres uses FOR UPDATE SKIP LOCKED. Here the claim is one
 * UPDATE ... WHERE id IN (SELECT ... ORDER BY ... LIMIT ?) AND status = 'approved'
 * RETURNING statement; a single SQLite statement is atomic and D1 serialises
 * writes, so each row goes to exactly one concurrent caller. The ordering matches
 * Postgres including NULL placement (pg: DESC puts NULLs first, ASC puts them last).
 * RETURNING carries flow_class / priority via scalar subqueries so the result can
 * be re-sorted in code (RETURNING order is unspecified, as in Postgres).
 *
 * isSuppressed: SQLite lower() folds ASCII only; Postgres lower() is Unicode aware.
 * Addresses are compared the same way for ASCII, which covers practically every
 * email address.
 */
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  contacts,
  flows,
  lifecycleMessages,
  suppressions,
  tenants,
  transportConfigs,
  topics,
  contactTopics,
} from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerDrainQueries } from "../areas/worker-drain.js";

interface ClaimRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_step_order: number | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  retry_count: number | null;
  topic_id: string | null;
  created_at: number | null;
  flow_class: string | null;
  priority: number | null;
}

/** critical first, priority DESC (NULLs first, as pg), created_at ASC (NULLs last, as pg). */
function compareClaims(a: ClaimRow, b: ClaimRow): number {
  const ca = a.flow_class === "critical" ? 0 : 1;
  const cb = b.flow_class === "critical" ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const pa = a.priority === null ? Number.POSITIVE_INFINITY : a.priority;
  const pb = b.priority === null ? Number.POSITIVE_INFINITY : b.priority;
  if (pa !== pb) return pb - pa;
  const ta = a.created_at === null ? Number.POSITIVE_INFINITY : a.created_at;
  const tb = b.created_at === null ? Number.POSITIVE_INFINITY : b.created_at;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

export function d1WorkerDrain(db: D1Db): WorkerDrainQueries {
  /** CAS on lifecycle_messages: set `values` where id = messageId and status = 'sending'. */
  async function casFromSending(
    messageId: string,
    values: Partial<typeof lifecycleMessages.$inferInsert>,
  ): Promise<boolean> {
    const updated = await db
      .update(lifecycleMessages)
      .set(values)
      .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")))
      .returning({ id: lifecycleMessages.id });
    return updated.length > 0;
  }

  return {
    async claimDrainBatch({ now, limit, tenantIds }) {
      if (tenantIds.length === 0) return [];
      const nowMs = now.getTime();
      const rows = await db.all<ClaimRow>(sql`
        UPDATE lifecycle_messages
        SET status = 'sending', updated_at = ${nowMs}
        WHERE id IN (
            SELECT lm.id
            FROM lifecycle_messages lm
            JOIN flows f ON f.id = lm.flow_id
            WHERE lm.status = 'approved'
              AND lm.tenant_id IN (SELECT value FROM json_each(${JSON.stringify(tenantIds)}))
              AND (lm.scheduled_send_at IS NULL OR lm.scheduled_send_at <= ${nowMs})
            ORDER BY
              CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END ASC,
              f.priority IS NULL DESC,
              f.priority DESC,
              lm.created_at IS NULL ASC,
              lm.created_at ASC
            LIMIT ${limit}
          )
          AND status = 'approved'
        RETURNING id, tenant_id, contact_id, flow_id, flow_step_order,
                  subject, body_html, body_text, retry_count, created_at, topic_id,
                  (SELECT f2.flow_class FROM flows f2 WHERE f2.id = flow_id) AS flow_class,
                  (SELECT f2.priority FROM flows f2 WHERE f2.id = flow_id) AS priority
      `);
      rows.sort(compareClaims);
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        contactId: row.contact_id,
        flowId: row.flow_id,
        flowStepOrder: row.flow_step_order,
        subject: row.subject,
        bodyHtml: row.body_html,
        bodyText: row.body_text,
        retryCount: row.retry_count,
        topicId: row.topic_id ?? null,
      }));
    },

    async listTenantsWithDueMessages(now) {
      const rows = await db.all<{ tenant_id: string }>(sql`
        SELECT DISTINCT tenant_id
        FROM lifecycle_messages
        WHERE status = 'approved'
          AND (scheduled_send_at IS NULL OR scheduled_send_at <= ${now.getTime()})
      `);
      return rows.map((r) => r.tenant_id);
    },

    async getTransportDailyLimit(tenantId) {
      const rows = await db
        .select({ dailyLimit: transportConfigs.dailyLimit })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
        .limit(1);
      return rows[0]?.dailyLimit ?? null;
    },

    async countSentSince(tenantId, since, transportId) {
      const rows = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(lifecycleMessages)
        .where(
          and(
            eq(lifecycleMessages.tenantId, tenantId),
            eq(lifecycleMessages.status, "sent"),
            gte(lifecycleMessages.sentAt, since),
            transportId
              ? or(eq(lifecycleMessages.transportId, transportId), isNull(lifecycleMessages.transportId))
              : undefined,
          ),
        );
      return Number(rows[0]?.cnt ?? 0);
    },

    releaseClaim(messageId, now) {
      return casFromSending(messageId, { status: "approved", updatedAt: now });
    },

    deferClaim(messageId, sendAt, now) {
      return casFromSending(messageId, { status: "approved", scheduledSendAt: sendAt, updatedAt: now });
    },

    markSuppressed(messageId, now, reason) {
      return casFromSending(messageId, { status: "suppressed", updatedAt: now, ...(reason ? { statusReason: reason } : {}) });
    },

    setRecipientAddress(messageId, email, now, transportId) {
      return casFromSending(messageId, { recipientAddress: email, updatedAt: now, ...(transportId ? { transportId } : {}) });
    },

    markSent(messageId, providerMessageId, now, transportId) {
      return casFromSending(messageId, {
        status: "sent",
        sentAt: now,
        providerMessageId,
        updatedAt: now,
        ...(transportId ? { transportId } : {}),
      });
    },

    markFailed(messageId, now, reason) {
      return casFromSending(messageId, { status: "failed", updatedAt: now, ...(reason ? { statusReason: reason } : {}) });
    },

    async getTopicGate({ tenantId, contactId, topicId }) {
      const rows = await db
        .select({
          kind: topics.kind,
          defaultSubscribed: topics.defaultSubscribed,
          status: contactTopics.status,
        })
        .from(topics)
        .leftJoin(
          contactTopics,
          and(eq(contactTopics.topicId, topics.id), eq(contactTopics.contactId, contactId)),
        )
        .where(and(eq(topics.id, topicId), eq(topics.tenantId, tenantId)))
        .limit(1);
      const row = rows[0];
      return row ? { kind: row.kind, defaultSubscribed: row.defaultSubscribed, status: row.status ?? null } : null;
    },

    async getContact(contactId) {
      const rows = await db
        .select({ email: contacts.email, properties: contacts.properties })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      return rows[0] ?? null;
    },

    async isSuppressed(tenantId, email) {
      const rows = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(eq(suppressions.tenantId, tenantId), sql`lower(${suppressions.email}) = lower(${email})`))
        .limit(1);
      return rows.length > 0;
    },

    async getFlowThrottleInfo(flowId) {
      const rows = await db
        .select({ flowClass: flows.flowClass, compiledPlan: flows.compiledPlan })
        .from(flows)
        .where(eq(flows.id, flowId))
        .limit(1);
      return rows[0] ?? null;
    },

    async getTenantSettings(tenantId) {
      const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return rows.length > 0 ? rows[0]!.settings : null;
    },

    async getRecentSends(contactId, since24h, since7d) {
      const rows = await db
        .select({
          count24h: sql<number>`sum(case when ${lifecycleMessages.sentAt} >= ${since24h.getTime()} then 1 else 0 end)`,
          count7d: sql<number>`count(*)`,
          lastSent: sql<number | null>`max(${lifecycleMessages.sentAt})`,
        })
        .from(lifecycleMessages)
        .where(
          and(
            eq(lifecycleMessages.contactId, contactId),
            inArray(lifecycleMessages.status, ["sending", "sent"]),
            gte(lifecycleMessages.sentAt, since7d),
          ),
        );
      const row = rows[0];
      const lastSent = row?.lastSent ?? null;
      return {
        countLast24h: Number(row?.count24h ?? 0),
        countLast7d: Number(row?.count7d ?? 0),
        lastSentAt: lastSent === null ? null : new Date(Number(lastSent)),
      };
    },

    async getSender(tenantId) {
      const rows = await db
        .select({ fromEmail: transportConfigs.fromEmail, fromName: transportConfigs.fromName })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
        .limit(1);
      return rows[0] ?? null;
    },

    async getTenant(tenantId) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings, publicHost: tenants.publicHost })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
