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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  resolveLifecycleConfig,
  recencyThresholdDays,
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
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

  const tenantRows: { id: string; settings: unknown }[] =
    await storeFor(db).workerSnapshotRetentionGrid.listTenants(tenantIds);

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const config: LifecycleConfig = resolveLifecycleConfig(
      settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
    );
    const recencyDays = recencyThresholdDays(config.natural_frequency_days);

    // Same bucketing as GET /v1/analytics/retention-grid.
    const cells = await storeFor(db).workerSnapshotRetentionGrid.countGridCells({
      tenantId: tenant.id,
      recencyDays,
    });

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

    await storeFor(db).workerSnapshotRetentionGrid.upsertSnapshotRows(rows);

    result.tenantsProcessed++;
    result.rowsWritten += rows.length;
  }

  return result;
}
