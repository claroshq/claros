/**
 * Postgres implementation of ../areas/api-admin-auth.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiAdminAuthQueries } from "../areas/api-admin-auth.js";

export function pgApiAdminAuth(db: PgDb): ApiAdminAuthQueries {
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

    async findActiveInstanceKeyByHash(keyHash) {
      const rows = await db
        .select({ id: apiKeys.id, scopes: apiKeys.scopes })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), eq(apiKeys.kind, "instance"), isNull(apiKeys.tenantId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, scopes: Array.isArray(row.scopes) ? row.scopes : [] };
    },

    async findProductBySlug(slug) {
      const rows = await db
        .select({ id: tenants.id, slug: tenants.slug, archivedAt: tenants.archivedAt })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
