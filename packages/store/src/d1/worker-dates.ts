/**
 * SQLite / D1 implementation of ../areas/worker-dates.ts. The stale-exit
 * unit is one batch: the message cancel is guarded by the membership still
 * being active, the exit is a CAS, and the flow.exited event is written only
 * when the exit changed a row.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { flows, flowMemberships, lifecycleMessages, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";
import { d1ContactConditions } from "./contact-conditions.js";
import type { WorkerDatesQueries } from "../areas/worker-dates.js";

const UNSENT = sql`('pending_generation', 'awaiting_content', 'pending_approval', 'approved')`;

export function d1WorkerDates(db: D1Db): WorkerDatesQueries {
  return {
    ...d1ContactConditions(db),

    async listTenants(tenantIds) {
      const q = db.select({ id: tenants.id, settings: tenants.settings }).from(tenants);
      if (tenantIds && tenantIds.length > 0) return q.where(inArray(tenants.id, tenantIds)).orderBy(tenants.id);
      return q.orderBy(tenants.id);
    },

    async getTenantSettings(tenantId) {
      const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      const s = rows[0]?.settings;
      return s && typeof s === "object" ? (s as Record<string, unknown>) : null;
    },

    async listActiveDateFlows(tenantId) {
      return db
        .select({
          id: flows.id,
          tenantId: flows.tenantId,
          priority: flows.priority,
          triggerType: flows.triggerType,
          triggerConfig: flows.triggerConfig,
          flowClass: flows.flowClass,
          reentryPolicy: flows.reentryPolicy,
          reentryCooldownDays: flows.reentryCooldownDays,
        })
        .from(flows)
        .where(
          and(
            eq(flows.tenantId, tenantId),
            eq(flows.status, "active"),
            inArray(flows.triggerType, ["date_property", "date_schedule"]),
            eq(flows.compileStatus, "ready"),
            sql`${flows.compiledPlan} IS NOT NULL`,
          ),
        )
        .orderBy(flows.id);
    },

    async listStaleMemberships({ tenantId, flowId, property, limit }) {
      const rows = await db.all<{ id: string; contact_id: string }>(sql`
        SELECT m.id, m.contact_id
        FROM flow_memberships m
        LEFT JOIN contact_dates d
          ON d.tenant_id = m.tenant_id AND d.contact_id = m.contact_id AND d.property = ${property}
        WHERE m.tenant_id = ${tenantId}
          AND m.flow_id = ${flowId}
          AND m.status = 'active'
          AND m.anchor_at IS NOT NULL
          AND (d.value IS NULL OR d.value <> m.anchor_at)
        ORDER BY m.id
        LIMIT ${limit}
      `);
      return rows.map((r) => ({ membershipId: r.id, contactId: r.contact_id }));
    },

    async listDueCandidates({ tenantId, flowId, property, from, to, afterContactId, limit }) {
      const rows = await db.all<{ contact_id: string; value: number; timezone: string | null }>(sql`
        SELECT d.contact_id, d.value, json_extract(c.properties, '$.timezone') AS timezone
        FROM contact_dates d
        JOIN contacts c ON c.id = d.contact_id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${tenantId}
          AND d.property = ${property}
          AND d.value >= ${from.getTime()}
          AND d.value <= ${to.getTime()}
          ${afterContactId ? sql`AND d.contact_id > ${afterContactId}` : sql``}
          AND NOT EXISTS (
            SELECT 1 FROM flow_memberships m
            WHERE m.tenant_id = d.tenant_id AND m.flow_id = ${flowId}
              AND m.contact_id = d.contact_id AND m.anchor_at = d.value
          )
        ORDER BY d.contact_id
        LIMIT ${limit}
      `);
      return rows.map((r) => ({
        contactId: r.contact_id,
        value: new Date(Number(r.value)),
        timezone: typeof r.timezone === "string" ? r.timezone : null,
      }));
    },

    async getContactDate({ tenantId, contactId, property }) {
      const rows = await db.all<{ value: number }>(sql`
        SELECT value FROM contact_dates WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND property = ${property}
      `);
      const v = rows[0]?.value;
      return v === undefined ? null : new Date(Number(v));
    },

    async exitStaleMembership({ tenantId, membershipId, contactId, flowId, reason, now }) {
      const cancel = db
        .update(lifecycleMessages)
        .set({ status: "cancelled", statusReason: reason, updatedAt: now })
        .where(
          and(
            eq(lifecycleMessages.tenantId, tenantId),
            eq(lifecycleMessages.membershipId, membershipId),
            sql`${lifecycleMessages.status} IN ${UNSENT}`,
            sql`EXISTS (SELECT 1 FROM flow_memberships WHERE id = ${membershipId} AND status = 'active')`,
          ),
        );
      const exit = db
        .update(flowMemberships)
        .set({ status: "exited", exitedAt: now, exitReason: reason })
        .where(and(eq(flowMemberships.id, membershipId), eq(flowMemberships.tenantId, tenantId), eq(flowMemberships.status, "active")))
        .returning({ id: flowMemberships.id });
      const outbox = [{ event: "flow.exited", payload: { membership_id: membershipId, contact_id: contactId, flow_id: flowId, reason } }];
      const endpoints = await d1OutboxEndpoints(db, tenantId, outbox);
      const results = (await db.batch([cancel, exit, ...d1OutboxInserts(db, tenantId, endpoints, outbox, now, { afterChange: true })] as never)) as unknown[];
      const exited = results[1] as Array<{ id: string }>;
      return exited.length > 0;
    },

    async jumpMembershipStep({ membershipId, fromStep, toStep }) {
      const rows = await db
        .update(flowMemberships)
        .set({ currentStep: toStep })
        .where(and(eq(flowMemberships.id, membershipId), eq(flowMemberships.status, "active"), eq(flowMemberships.currentStep, fromStep)))
        .returning({ id: flowMemberships.id });
      return rows.length > 0;
    },

    async cancelExpiredMessages({ now, limit }) {
      const rows = await db.all<{ id: string; tenant_id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'cancelled', status_reason = 'expired', updated_at = ${now.getTime()}
        WHERE id IN (
          SELECT id FROM lifecycle_messages
          WHERE expires_at IS NOT NULL AND expires_at < ${now.getTime()} AND status IN ${UNSENT}
          ORDER BY expires_at
          LIMIT ${limit}
        )
        AND status IN ${UNSENT}
        RETURNING id, tenant_id
      `);
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
    },
  };
}
