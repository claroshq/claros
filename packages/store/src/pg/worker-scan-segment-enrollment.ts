/**
 * Postgres implementation of the queries used by packages/worker/src/scan-segment-enrollment.ts.
 */
import { eq, and, inArray, gt, sql } from "drizzle-orm";
import { contacts, flows, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import { pgContactConditions } from "./contact-conditions.js";
import type { WorkerScanSegmentEnrollmentQueries } from "../areas/worker-scan-segment-enrollment.js";

export function pgWorkerScanSegmentEnrollment(db: PgDb): WorkerScanSegmentEnrollmentQueries {
  return {
    ...pgContactConditions(db),
    async listTenants(tenantIds) {
      if (tenantIds && tenantIds.length > 0) {
        return db
          .select({ id: tenants.id, settings: tenants.settings })
          .from(tenants)
          .where(inArray(tenants.id, tenantIds))
          .orderBy(tenants.id);
      }
      return db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .orderBy(tenants.id);
    },

    async listActiveSegmentFlows(tenantId) {
      // Small cardinality: a tenant typically has < 50 flows total.
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
            eq(flows.triggerType, "segment"),
            eq(flows.compileStatus, "ready"),
            sql`${flows.compiledPlan} IS NOT NULL`,
          ),
        );
    },

    async listCellContactsPage({ tenantId, flowId, now, tenure, recency, afterId, limit }) {
      // Contacts whose tenure and recency ages fall inside the cell, excluding
      // anyone already actively enrolled in this flow. Keyset pagination by id.
      return db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            sql`${contacts.firstSeenAt} <= ${now}::timestamptz - make_interval(days => ${tenure.minDays})`,
            tenure.maxDays === null
              ? undefined
              : sql`${contacts.firstSeenAt} > ${now}::timestamptz - make_interval(days => ${tenure.maxDays})`,
            sql`${contacts.lastSeenAt} <= ${now}::timestamptz - make_interval(days => ${recency.minDays})`,
            recency.maxDays === null
              ? undefined
              : sql`${contacts.lastSeenAt} > ${now}::timestamptz - make_interval(days => ${recency.maxDays})`,
            sql`NOT EXISTS (
              SELECT 1 FROM flow_memberships fm
              WHERE fm.contact_id = ${contacts.id}
                AND fm.flow_id = ${flowId}
                AND fm.status = 'active'
            )`,
            afterId === null ? undefined : gt(contacts.id, afterId),
          ),
        )
        .orderBy(contacts.id)
        .limit(limit);
    },

    async listStateContactsPage({ tenantId, flowId, states, depths, afterId, limit }) {
      return db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            states && states.length > 0 ? inArray(contacts.lifecycleState, states) : undefined,
            depths && depths.length > 0 ? inArray(contacts.engagementDepth, depths) : undefined,
            sql`NOT EXISTS (
              SELECT 1 FROM flow_memberships fm
              WHERE fm.contact_id = ${contacts.id}
                AND fm.flow_id = ${flowId}
                AND fm.status = 'active'
            )`,
            afterId === null ? undefined : gt(contacts.id, afterId),
          ),
        )
        .orderBy(contacts.id)
        .limit(limit);
    },
  };
}
