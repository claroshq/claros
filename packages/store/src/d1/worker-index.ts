/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-index.ts.
 */
import { isNull } from "drizzle-orm";
import { tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerIndexQueries } from "../areas/worker-index.js";

export function d1WorkerIndex(db: D1Db): WorkerIndexQueries {
  return {
    async getAnyTenantSettings() {
      const tenantRows = await db.select({ settings: tenants.settings }).from(tenants).limit(1);
      return tenantRows[0] ?? null;
    },

    async listActiveTenantIds() {
      const rows = await db.select({ id: tenants.id }).from(tenants).where(isNull(tenants.archivedAt)).orderBy(tenants.id);
      return rows.map((r) => r.id);
    },
  };
}
