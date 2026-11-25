/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-reap.ts.
 *
 * Each UPDATE is an atomic CAS (WHERE status = <expected> AND updated_at < <threshold>);
 * if another actor already advanced the row, the update hits 0 rows.
 */
import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerReapQueries, WorkerReapStuckInput } from "../areas/worker-reap.js";

/** Optional tenant scope; the list is bound as one JSON array to stay under D1's parameter limit. */
function tenantFilterFor(tenantIds?: string[]): SQL | undefined {
  return tenantIds && tenantIds.length > 0
    ? sql`${lifecycleMessages.tenantId} IN (SELECT value FROM json_each(${JSON.stringify(tenantIds)}))`
    : undefined;
}

function stuck({ stuckStatus, threshold, tenantIds }: WorkerReapStuckInput): SQL[] {
  const conds: SQL[] = [eq(lifecycleMessages.status, stuckStatus), lt(lifecycleMessages.updatedAt, threshold)];
  const tenantFilter = tenantFilterFor(tenantIds);
  if (tenantFilter) conds.push(tenantFilter);
  return conds;
}

export function d1WorkerReap(db: D1Db): WorkerReapQueries {
  return {
    async retryStuckMessages(input) {
      return db
        .update(lifecycleMessages)
        .set({
          status: input.retryStatus,
          retryCount: sql`${lifecycleMessages.retryCount} + 1`,
          updatedAt: input.now,
        })
        .where(and(...stuck(input), lt(lifecycleMessages.retryCount, input.maxRetryCount)))
        .returning({ id: lifecycleMessages.id, tenant_id: lifecycleMessages.tenantId });
    },

    async failStuckMessages(input) {
      return db
        .update(lifecycleMessages)
        .set({ status: "failed", updatedAt: input.now })
        .where(and(...stuck(input), gte(lifecycleMessages.retryCount, input.maxRetryCount)))
        .returning({ id: lifecycleMessages.id, tenant_id: lifecycleMessages.tenantId });
    },
  };
}
