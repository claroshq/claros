/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-enrollment.ts.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { flows } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerScanEnrollmentQueries } from "../areas/worker-scan-enrollment.js";

export function d1WorkerScanEnrollment(db: D1Db): WorkerScanEnrollmentQueries {
  return {
    async listActiveLifecycleTransitionFlows(tenantId) {
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
            isNotNull(flows.compiledPlan),
          ),
        );
    },
  };
}
