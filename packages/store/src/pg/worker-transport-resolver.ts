/**
 * Postgres implementation of the queries used by packages/worker/src/transport-resolver.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerActiveTransportRow,
  WorkerTransportConfigRow,
  WorkerTransportResolverQueries,
} from "../areas/worker-transport-resolver.js";
import { routingFromSettings } from "../shared/transport-routing.js";

export function pgWorkerTransportResolver(db: PgDb): WorkerTransportResolverQueries {
  return {
    async getActiveTransportConfig(tenantId) {
      const rows = await db.execute<WorkerTransportConfigRow & Record<string, unknown>>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `);
      return rows.rows[0] ?? null;
    },

    async listActiveTransports(tenantId) {
      const rows = await db.execute<WorkerActiveTransportRow & Record<string, unknown>>(sql`
        SELECT id, COALESCE(kind, provider) AS kind, provider, config::text AS config,
               from_email, from_name, reply_to, daily_limit
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        ORDER BY created_at ASC, id ASC
      `);
      return rows.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        provider: r.provider,
        config: r.config,
        from_email: r.from_email,
        from_name: r.from_name,
        reply_to: r.reply_to,
        daily_limit: r.daily_limit,
      }));
    },

    async getTransportRouting(tenantId) {
      const rows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}::uuid
      `);
      return routingFromSettings(rows.rows[0]?.settings);
    },
  };
}
