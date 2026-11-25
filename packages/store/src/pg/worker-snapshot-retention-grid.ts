/**
 * Postgres implementation of the queries used by packages/worker/src/snapshot-retention-grid.ts.
 */
import { inArray, sql } from "drizzle-orm";
import { retentionGridSnapshots, tenants } from "@claros/db/schema";
import { RETENTION_TENURE_THRESHOLDS_DAYS } from "@claros/core";
import type { PgDb } from "./db.js";
import type {
  WorkerSnapshotRetentionGridQueries,
  WorkerGridCellRow,
} from "../areas/worker-snapshot-retention-grid.js";

export function pgWorkerSnapshotRetentionGrid(db: PgDb): WorkerSnapshotRetentionGridQueries {
  return {
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

    async countGridCells({ tenantId, recencyDays }) {
      // Same bucketing as GET /v1/analytics/retention-grid.
      return (
        await db.execute<WorkerGridCellRow & Record<string, unknown>>(sql`
          SELECT
            CASE
              WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.growing}) THEN 'new'
              WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.established}) THEN 'growing'
              WHEN first_seen_at >= now() - make_interval(days => ${RETENTION_TENURE_THRESHOLDS_DAYS.loyal}) THEN 'established'
              ELSE 'loyal'
            END AS tenure,
            CASE
              WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.cooling}) THEN 'active'
              WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.idle}) THEN 'cooling'
              WHEN last_seen_at >= now() - make_interval(days => ${recencyDays.dormant}) THEN 'idle'
              ELSE 'dormant'
            END AS recency,
            count(*)::int AS count,
            count(*) FILTER (WHERE payment_status IN ('paid', 'past_due'))::int AS paying
          FROM contacts
          WHERE tenant_id = ${tenantId}
          GROUP BY 1, 2
        `)
      ).rows;
    },

    async upsertSnapshotRows(rows) {
      await db
        .insert(retentionGridSnapshots)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            retentionGridSnapshots.tenantId,
            retentionGridSnapshots.snapshotDate,
            retentionGridSnapshots.tenureBucket,
            retentionGridSnapshots.recencyBucket,
          ],
          set: {
            contactCount: sql`excluded.contact_count`,
            payingCount: sql`excluded.paying_count`,
          },
        });
    },
  };
}
