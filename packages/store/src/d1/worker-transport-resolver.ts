/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-transport-resolver.ts.
 *
 * config is returned as the stored JSON text. Postgres returns jsonb::text, which can differ
 * in whitespace and key order; the caller parses it, so the parsed values are equal.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { tenants, transportConfigs } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerTransportResolverQueries } from "../areas/worker-transport-resolver.js";
import { routingFromSettings } from "../shared/transport-routing.js";

export function d1WorkerTransportResolver(db: D1Db): WorkerTransportResolverQueries {
  return {
    async getActiveTransportConfig(tenantId) {
      const rows = await db
        .select({
          provider: transportConfigs.provider,
          // Raw column (not the json-mode column) so the text is not parsed.
          config: sql<string>`${sql.identifier("config")}`,
          from_email: transportConfigs.fromEmail,
          from_name: transportConfigs.fromName,
        })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listActiveTransports(tenantId) {
      return db
        .select({
          id: transportConfigs.id,
          kind: sql<string>`COALESCE(${transportConfigs.kind}, ${transportConfigs.provider})`,
          provider: transportConfigs.provider,
          config: sql<string>`${sql.identifier("config")}`,
          from_email: transportConfigs.fromEmail,
          from_name: transportConfigs.fromName,
          reply_to: transportConfigs.replyTo,
          daily_limit: transportConfigs.dailyLimit,
        })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id));
    },

    async getTransportRouting(tenantId) {
      const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return routingFromSettings(rows[0]?.settings);
    },
  };
}
