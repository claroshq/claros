/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-trigger-check.ts.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { flows } from "@claros/db/schema-sqlite";
import { d1ContactConditions } from "./contact-conditions.js";
import type { D1Db } from "./db.js";
import type { WorkerTriggerCheckQueries } from "../areas/worker-trigger-check.js";

export function d1WorkerTriggerCheck(db: D1Db): WorkerTriggerCheckQueries {
  return {
    ...d1ContactConditions(db),
    async listActiveEventFlows(tenantId) {
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
            isNotNull(flows.compiledPlan),
          ),
        );
    },
  };
}
