/**
 * Postgres implementation of the queries used by packages/worker/src/transport-resolver.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerTransportConfigRow,
  WorkerTransportResolverQueries,
} from "../areas/worker-transport-resolver.js";

export function pgWorkerTransportResolver(db: PgDb): WorkerTransportResolverQueries {
  return {
    async getActiveTransportConfig(tenantId) {
      const rows = await db.execute<WorkerTransportConfigRow & Record<string, unknown>>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        LIMIT 1
      `);
      return rows.rows[0] ?? null;
    },
  };
}
