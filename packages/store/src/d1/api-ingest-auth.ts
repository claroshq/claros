/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingest-auth.ts.
 */
import { eq, isNull, isNotNull, and, inArray } from "drizzle-orm";
import { apiKeys, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiIngestAuthQueries } from "../areas/api-ingest-auth.js";

export function d1ApiIngestAuth(db: D1Db): ApiIngestAuthQueries {
  return {
    async findActiveKeyByHash(keyHash) {
      const rows = await db
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
          kind: apiKeys.kind,
          allowedOrigins: apiKeys.allowedOrigins,
          archivedAt: tenants.archivedAt,
        })
        .from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .where(
          and(
            eq(apiKeys.keyHash, keyHash),
            isNull(apiKeys.revokedAt),
            // Admin and instance keys do not authenticate ingestion.
            inArray(apiKeys.kind, ["publishable", "secret"]),
            isNotNull(apiKeys.tenantId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || row.tenantId === null) return null;
      const { archivedAt, ...rest } = row;
      return { ...rest, tenantId: row.tenantId, tenantArchived: archivedAt != null };
    },

    async touchKeyLastUsed(apiKeyId, at) {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
    },
  };
}
