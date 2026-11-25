/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-snapshot-retention-grid.ts.
 *
 * Bucket cutoffs (pg: now() - make_interval(days => n)) are computed in JS
 * from the current time and bound as millisecond timestamps;
 * count(*) FILTER (...) becomes SUM(CASE ...).
 */
import { inArray, sql } from "drizzle-orm";
import { retentionGridSnapshots, tenants } from "@claros/db/schema-sqlite";
import { RETENTION_TENURE_THRESHOLDS_DAYS } from "@claros/core";
import type { D1Db } from "./db.js";
import type {
  WorkerSnapshotRetentionGridQueries,
  WorkerGridCellRow,
} from "../areas/worker-snapshot-retention-grid.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Snapshot rows per INSERT: 6 params each, under D1's 100 bound parameters. */
const ROWS_PER_STATEMENT = 16;

export function d1WorkerSnapshotRetentionGrid(db: D1Db): WorkerSnapshotRetentionGridQueries {
  return {
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

    async countGridCells({ tenantId, recencyDays }) {
      const now = Date.now();
      const ago = (days: number) => now - days * DAY_MS;
      const rows = await db.all<WorkerGridCellRow>(sql`
        SELECT
          CASE
            WHEN first_seen_at >= ${ago(RETENTION_TENURE_THRESHOLDS_DAYS.growing)} THEN 'new'
            WHEN first_seen_at >= ${ago(RETENTION_TENURE_THRESHOLDS_DAYS.established)} THEN 'growing'
            WHEN first_seen_at >= ${ago(RETENTION_TENURE_THRESHOLDS_DAYS.loyal)} THEN 'established'
            ELSE 'loyal'
          END AS tenure,
          CASE
            WHEN last_seen_at >= ${ago(recencyDays.cooling)} THEN 'active'
            WHEN last_seen_at >= ${ago(recencyDays.idle)} THEN 'cooling'
            WHEN last_seen_at >= ${ago(recencyDays.dormant)} THEN 'idle'
            ELSE 'dormant'
          END AS recency,
          count(*) AS count,
          SUM(CASE WHEN payment_status IN ('paid', 'past_due') THEN 1 ELSE 0 END) AS paying
        FROM contacts
        WHERE tenant_id = ${tenantId}
        GROUP BY 1, 2
      `);
      return rows.map((r) => ({
        tenure: r.tenure,
        recency: r.recency,
        count: Number(r.count),
        paying: Number(r.paying),
      }));
    },

    async upsertSnapshotRows(rows) {
      if (rows.length === 0) return;
      const statements = [];
      for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
        statements.push(
          db
            .insert(retentionGridSnapshots)
            .values(rows.slice(i, i + ROWS_PER_STATEMENT))
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
            }),
        );
      }
      await db.batch(statements as [typeof statements[number], ...typeof statements]);
    },
  };
}
