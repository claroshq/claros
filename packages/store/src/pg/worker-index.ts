/**
 * Postgres implementation of the queries used by packages/worker/src/index.ts.
 */
import { tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerIndexQueries } from "../areas/worker-index.js";

export function pgWorkerIndex(db: PgDb): WorkerIndexQueries {
  return {
    async getAnyTenantSettings() {
      const tenantRows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .limit(1);
      return tenantRows[0] ?? null;
    },
  };
}
