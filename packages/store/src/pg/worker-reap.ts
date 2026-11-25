/**
 * Postgres implementation of the queries used by packages/worker/src/reap.ts.
 *
 * Each UPDATE is atomic CAS:
 *   WHERE status = <expected> AND updated_at < <threshold>
 * If drain (or anything else) has already advanced the row, the update hits
 * 0 rows and the other actor's outcome wins.
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerReapedMessage,
  WorkerReapQueries,
  WorkerReapRetryStatus,
  WorkerReapStuckStatus,
} from "../areas/worker-reap.js";

/** Status literals, kept inline in the SQL as before (closed set, never user input). */
const STATUS_LITERAL: Record<WorkerReapStuckStatus | WorkerReapRetryStatus, SQL> = {
  sending: sql.raw(`'sending'`),
  generating: sql.raw(`'generating'`),
  awaiting_content: sql.raw(`'awaiting_content'`),
  approved: sql.raw(`'approved'`),
  pending_generation: sql.raw(`'pending_generation'`),
};

// Optional tenant scope fragment. When tenantIds is provided, only those
// tenants' messages are processed. When omitted (production default), the
// fragment is a no-op (TRUE).
function tenantFilterFor(tenantIds?: string[]): SQL {
  return tenantIds && tenantIds.length > 0
    ? sql`AND tenant_id IN (${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
}

export function pgWorkerReap(db: PgDb): WorkerReapQueries {
  return {
    async retryStuckMessages({ stuckStatus, retryStatus, threshold, now, maxRetryCount, tenantIds }) {
      const tenantFilter = tenantFilterFor(tenantIds);
      // Retry: retry_count < MAX_RETRY_COUNT -> reset
      const result = await db.execute<WorkerReapedMessage & Record<string, unknown>>(sql`
        UPDATE lifecycle_messages
        SET
          status = ${STATUS_LITERAL[retryStatus]},
          retry_count = retry_count + 1,
          updated_at = ${now}
        WHERE status = ${STATUS_LITERAL[stuckStatus]}
          AND updated_at < ${threshold}
          AND retry_count < ${maxRetryCount}
          ${tenantFilter}
        RETURNING id, tenant_id
      `);
      return result.rows;
    },

    async failStuckMessages({ stuckStatus, threshold, now, maxRetryCount, tenantIds }) {
      const tenantFilter = tenantFilterFor(tenantIds);
      // Fail: retry_count >= MAX_RETRY_COUNT -> terminal 'failed'
      const result = await db.execute<WorkerReapedMessage & Record<string, unknown>>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'failed',
          updated_at = ${now}
        WHERE status = ${STATUS_LITERAL[stuckStatus]}
          AND updated_at < ${threshold}
          AND retry_count >= ${maxRetryCount}
          ${tenantFilter}
        RETURNING id, tenant_id
      `);
      return result.rows;
    },
  };
}
