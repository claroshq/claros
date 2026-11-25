/**
 * Postgres implementation of the queries used by packages/worker/src/partition-maintenance.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { WorkerPartitionMaintenanceQueries } from "../areas/worker-partition-maintenance.js";

export function pgWorkerPartitionMaintenance(db: PgDb): WorkerPartitionMaintenanceQueries {
  return {
    async partitionExists(name) {
      // Check if partition already exists in pg_class.
      const existing = await db.execute<{ exists: number }>(sql`
        SELECT 1 AS exists
        FROM pg_class
        WHERE relname = ${name}
          AND relkind = 'r'
      `);
      return existing.rows.length > 0;
    },

    async createEventsPartition({ name, start, end }) {
      // Create the partition. IF NOT EXISTS guards against races.
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events ` +
            `FOR VALUES FROM ('${start}') TO ('${end}')`,
        ),
      );
    },
  };
}
