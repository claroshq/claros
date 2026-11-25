/**
 * Postgres implementation of the queries used by packages/worker/src/trigger-check.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { flows } from "@claros/db/schema";
import { pgContactConditions } from "./contact-conditions.js";
import type { PgDb } from "./db.js";
import type { WorkerTriggerCheckQueries } from "../areas/worker-trigger-check.js";

export function pgWorkerTriggerCheck(db: PgDb): WorkerTriggerCheckQueries {
  return {
    ...pgContactConditions(db),
    async listActiveEventFlows(tenantId) {
      // Load active, compiled event-trigger flows for this tenant
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
            eq(flows.triggerType, "event"),
            eq(flows.compileStatus, "ready"),
            sql`${flows.compiledPlan} IS NOT NULL`,
          ),
        );
    },
  };
}
