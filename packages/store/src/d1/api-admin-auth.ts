/**
 * SQLite / Cloudflare D1 implementation of ../areas/api-admin-auth.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiAdminAuthQueries } from "../areas/api-admin-auth.js";

export function d1ApiAdminAuth(db: D1Db): ApiAdminAuthQueries {
  return {
    async findActiveAdminKeyByHash(keyHash) {
      const rows = await db
        .select({
          id: apiKeys.id,
          tenantId: tenants.id,
          tenantSlug: tenants.slug,
          tenantArchivedAt: tenants.archivedAt,
          scopes: apiKeys.scopes,
        })
        .from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), eq(apiKeys.kind, "admin")))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { ...row, scopes: Array.isArray(row.scopes) ? row.scopes : [] };
    },
  };
}
