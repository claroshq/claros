/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-segment-enrollment.ts.
 *
 * Day-based age cutoffs (pg: now - make_interval(days => n), UTC session) are
 * computed in JS as now - n * 24h and bound as millisecond timestamps.
 */
import { eq, and, inArray, gt, lte, isNotNull, sql } from "drizzle-orm";
import { contacts, flows, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { d1ContactConditions } from "./contact-conditions.js";
import type { WorkerScanSegmentEnrollmentQueries } from "../areas/worker-scan-segment-enrollment.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function d1WorkerScanSegmentEnrollment(db: D1Db): WorkerScanSegmentEnrollmentQueries {
  return {
    ...d1ContactConditions(db),
    async listTenants(tenantIds) {
      if (tenantIds && tenantIds.length > 0) {
        const out: { id: string; settings: unknown }[] = [];
        for (let i = 0; i < tenantIds.length; i += 90) {
          out.push(
            ...(await db
              .select({ id: tenants.id, settings: tenants.settings })
              .from(tenants)
              .where(inArray(tenants.id, tenantIds.slice(i, i + 90)))),
          );
        }
        return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      return db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .orderBy(tenants.id);
    },

    async listActiveSegmentFlows(tenantId) {
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
            isNotNull(flows.compiledPlan),
          ),
        );
    },

    async listCellContactsPage({ tenantId, flowId, now, tenure, recency, afterId, limit }) {
      const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
      return db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            lte(contacts.firstSeenAt, ago(tenure.minDays)),
            tenure.maxDays === null ? undefined : gt(contacts.firstSeenAt, ago(tenure.maxDays)),
            lte(contacts.lastSeenAt, ago(recency.minDays)),
            recency.maxDays === null ? undefined : gt(contacts.lastSeenAt, ago(recency.maxDays)),
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
