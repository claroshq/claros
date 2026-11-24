/**
 * Grid snapshot worker - records the day's retention-grid cell populations.
 *
 * Runs daily (cron). For each tenant, computes the same tenure x recency
 * bucketing the analytics endpoint serves and upserts 16 rows (one per
 * cell, zero-filled) into retention_grid_snapshots for the current UTC day.
 * The per-cell trend on the Lifecycle screen reads this table.
 *
 * Idempotent: the upsert targets the primary key
 * (tenant_id, snapshot_date, tenure_bucket, recency_bucket), so a re-run on
 * the same day overwrites that day's rows rather than doubling them.
 *
 * Bucket boundaries come from the same core functions the read model and
 * segment enrollment use, so a snapshot row, a screen cell, and a segment
 * flow's audience are the same set by construction. Counts reflect the
 * thresholds in effect at write time; history is not rewritten when a
 * tenant changes natural_frequency_days.
 */
import { inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { retentionGridSnapshots, tenants } from "@claros/db/schema";
import {
  resolveLifecycleConfig,
  recencyThresholdDays,
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  RETENTION_TENURE_THRESHOLDS_DAYS,
  type LifecycleConfig,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface GridSnapshotResult {
  tenantsProcessed: number;
  /** Rows upserted across all tenants (16 per tenant). */
  rowsWritten: number;
  /** UTC day the snapshot describes (YYYY-MM-DD). */
  snapshotDate: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Snapshots every tenant's retention-grid cell populations for the UTC day
 * containing `now`.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope (production default: all).
 */
export async function processGridSnapshotTick(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<GridSnapshotResult> {
  const snapshotDate = now.toISOString().slice(0, 10);
  const result: GridSnapshotResult = {
    tenantsProcessed: 0,
    rowsWritten: 0,
    snapshotDate,
  };

  let tenantRows: { id: string; settings: unknown }[];
  if (tenantIds && tenantIds.length > 0) {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds))
      .orderBy(tenants.id);
  } else {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .orderBy(tenants.id);
  }

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const config: LifecycleConfig = resolveLifecycleConfig(
      settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
    );
    const recencyDays = recencyThresholdDays(config.natural_frequency_days);

    // Same bucketing as GET /v1/analytics/retention-grid.
    const cells = (
      await db.execute<{
        tenure: string;
        recency: string;
        count: number;
        paying: number;
      }>(sql`
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
        WHERE tenant_id = ${tenant.id}
        GROUP BY 1, 2
      `)
    ).rows;

    const cellMap = new Map(cells.map((c) => [`${c.tenure}:${c.recency}`, c]));

    // Zero-fill all 16 cells so a cell draining to zero records 0, not a gap.
    const rows = RETENTION_TENURE_BUCKETS.flatMap((tenure) =>
      RETENTION_RECENCY_BUCKETS.map((recency) => {
        const cell = cellMap.get(`${tenure}:${recency}`);
        return {
          tenantId: tenant.id,
          snapshotDate,
          tenureBucket: tenure,
          recencyBucket: recency,
          contactCount: cell?.count ?? 0,
          payingCount: cell?.paying ?? 0,
        };
      }),
    );

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

    result.tenantsProcessed++;
    result.rowsWritten += rows.length;
  }

  return result;
}
