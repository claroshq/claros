/**
 * Postgres implementation of the queries used by packages/worker/src/scan-enrollment.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { flows } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import { pgContactConditions } from "./contact-conditions.js";
import type { WorkerScanEnrollmentQueries } from "../areas/worker-scan-enrollment.js";

export function pgWorkerScanEnrollment(db: PgDb): WorkerScanEnrollmentQueries {
  return {
    ...pgContactConditions(db),
    async listActiveLifecycleTransitionFlows(tenantId) {
      // Load all active, compiled lifecycle-transition flows for this tenant.
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
            eq(flows.triggerType, "lifecycle_transition"),
            eq(flows.compileStatus, "ready"),
            sql`${flows.compiledPlan} IS NOT NULL`,
          ),
        );
    },
  };
}
