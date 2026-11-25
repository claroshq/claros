/**
 * The tenant's active transport config with `config` as JSON text (shared by
 * the auth, team and profile areas). Postgres returns `config::text`, whose
 * jsonb formatting (key order, spacing) differs from the JSON text stored on
 * SQLite; callers parse it, so only the parsed value is the contract.
 */
import { and, eq, sql, asc } from "drizzle-orm";
import { transportConfigs } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";

export interface ActiveTransportText {
  provider: string;
  config: string;
  from_email: string;
  from_name: string | null;
}

export async function findActiveTransportText(db: D1Db, tenantId: string): Promise<ActiveTransportText | null> {
  const rows = await db
    .select({
      provider: transportConfigs.provider,
      // Raw column (no JSON parse): the stored JSON text.
      config: sql<string>`${transportConfigs.config}`,
      from_email: transportConfigs.fromEmail,
      from_name: transportConfigs.fromName,
    })
    .from(transportConfigs)
    .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
    .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
    .limit(1);
  return rows[0] ?? null;
}
