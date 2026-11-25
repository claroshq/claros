/**
 * Queries used by packages/worker/src/snapshot-retention-grid.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-snapshot-retention-grid.ts (Postgres) and, later,
 * ../d1/worker-snapshot-retention-grid.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Population of one retention-grid cell (tenure x recency). */
export interface WorkerGridCellRow {
  tenure: string;
  recency: string;
  count: number;
  paying: number;
}

/** One retention_grid_snapshots row to upsert. */
export interface WorkerGridSnapshotRow {
  tenantId: string;
  /** UTC day, YYYY-MM-DD. */
  snapshotDate: string;
  tenureBucket: string;
  recencyBucket: string;
  contactCount: number;
  payingCount: number;
}

export interface WorkerSnapshotRetentionGridQueries {
  /** Tenants (id, settings) ordered by id; restricted to tenantIds when given and non-empty. */
  listTenants(tenantIds?: string[]): Promise<{ id: string; settings: unknown }[]>;
  /**
   * Non-empty retention-grid cells of a tenant right now: tenure buckets from
   * the core thresholds, recency buckets from the tenant's day thresholds
   * (cooling, idle, dormant). Same bucketing as GET /v1/analytics/retention-grid.
   */
  countGridCells(input: {
    tenantId: string;
    recencyDays: { cooling: number; idle: number; dormant: number };
  }): Promise<WorkerGridCellRow[]>;
  /**
   * Upsert snapshot rows keyed by (tenant, day, tenure, recency); a re-run on
   * the same day overwrites that day's counts.
   */
  upsertSnapshotRows(rows: WorkerGridSnapshotRow[]): Promise<void>;
}
