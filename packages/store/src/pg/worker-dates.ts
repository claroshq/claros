/**
 * Postgres implementation of ../areas/worker-dates.ts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { flows, flowMemberships, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import { pgWriteOutbox } from "./outbox.js";
import { pgContactConditions } from "./contact-conditions.js";
import type { WorkerDatesQueries } from "../areas/worker-dates.js";

const UNSENT = sql`('pending_generation', 'awaiting_content', 'pending_approval', 'approved')`;

export function pgWorkerDates(db: PgDb): WorkerDatesQueries {
  return {
    ...pgContactConditions(db),

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
      const res = await db.execute<{ id: string; contact_id: string }>(sql`
        SELECT m.id, m.contact_id
        FROM flow_memberships m
        LEFT JOIN contact_dates d
          ON d.tenant_id = m.tenant_id AND d.contact_id = m.contact_id AND d.property = ${property}
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.flow_id = ${flowId}::uuid
          AND m.status = 'active'
          AND m.anchor_at IS NOT NULL
          AND (d.value IS NULL OR d.value <> m.anchor_at)
        ORDER BY m.id
        LIMIT ${limit}
      `);
      return res.rows.map((r) => ({ membershipId: r.id, contactId: r.contact_id }));
    },

    async listDueCandidates({ tenantId, flowId, property, from, to, afterContactId, limit }) {
      const res = await db.execute<{ contact_id: string; value: string | Date; timezone: string | null }>(sql`
        SELECT d.contact_id, d.value, c.properties->>'timezone' AS timezone
        FROM contact_dates d
        JOIN contacts c ON c.id = d.contact_id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.property = ${property}
          AND d.value >= ${from}
          AND d.value <= ${to}
          ${afterContactId ? sql`AND d.contact_id > ${afterContactId}::uuid` : sql``}
          AND NOT EXISTS (
            SELECT 1 FROM flow_memberships m
            WHERE m.tenant_id = d.tenant_id AND m.flow_id = ${flowId}::uuid
              AND m.contact_id = d.contact_id AND m.anchor_at = d.value
          )
        ORDER BY d.contact_id
        LIMIT ${limit}
      `);
      return res.rows.map((r) => ({ contactId: r.contact_id, value: new Date(r.value), timezone: r.timezone ?? null }));
    },

    async getContactDate({ tenantId, contactId, property }) {
      const res = await db.execute<{ value: string | Date }>(sql`
        SELECT value FROM contact_dates
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND property = ${property}
      `);
      const v = res.rows[0]?.value;
      return v === undefined ? null : new Date(v);
    },

    async exitStaleMembership({ tenantId, membershipId, contactId, flowId, reason, now }) {
      return db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as PgDb;
        const exited = await tx
          .update(flowMemberships)
          .set({ status: "exited", exitedAt: now, exitReason: reason })
          .where(and(eq(flowMemberships.id, membershipId), eq(flowMemberships.tenantId, tenantId), eq(flowMemberships.status, "active")))
          .returning({ id: flowMemberships.id });
        if (exited.length === 0) return false;
        await tx.execute(sql`
          UPDATE lifecycle_messages
          SET status = 'cancelled', status_reason = ${reason}, updated_at = ${now}
          WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid AND status IN ${UNSENT}
        `);
        await pgWriteOutbox(tx, tenantId, [
          { event: "flow.exited", payload: { membership_id: membershipId, contact_id: contactId, flow_id: flowId, reason } },
        ], now);
        return true;
      });
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
      const res = await db.execute<{ id: string; tenant_id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'cancelled', status_reason = 'expired', updated_at = ${now}
        WHERE id IN (
          SELECT id FROM lifecycle_messages
          WHERE expires_at IS NOT NULL AND expires_at < ${now} AND status IN ${UNSENT}
          ORDER BY expires_at
          LIMIT ${limit}
        )
        AND status IN ${UNSENT}
        RETURNING id, tenant_id
      `);
      return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
    },
  };
}
