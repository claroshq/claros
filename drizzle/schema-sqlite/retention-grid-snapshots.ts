import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/**
 * Daily snapshot of retention-grid cell populations.
 *
 * One row per tenant per UTC calendar day per grid cell (4 tenure buckets x
 * 4 recency buckets = 16 rows per tenant per day, written unconditionally -
 * empty cells get a zero row so a cell draining to zero shows 0 in the
 * trend, not a gap in the series).
 *
 * Written once per day by the grid-snapshot worker (QUEUE.GRID_SNAPSHOT).
 * Re-running on the same day overwrites that day's rows (upsert on the
 * primary key), so the job is idempotent and crash-safe.
 *
 * Counts reflect the tenure/recency thresholds in effect at write time; a
 * tenant who later changes natural_frequency_days does not rewrite history.
 */
export const retentionGridSnapshots = sqliteTable(
  "retention_grid_snapshots",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** UTC calendar day the snapshot describes (YYYY-MM-DD). */
    snapshotDate: text("snapshot_date").notNull(),
    tenureBucket: text("tenure_bucket").notNull(), // new|growing|established|loyal
    recencyBucket: text("recency_bucket").notNull(), // active|cooling|idle|dormant
    contactCount: integer("contact_count").notNull(),
    payingCount: integer("paying_count").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.snapshotDate,
        table.tenureBucket,
        table.recencyBucket,
      ],
    }),
  ]
);
