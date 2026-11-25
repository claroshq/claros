/**
 * Postgres implementation of the queries used by packages/api/src/http/ingest-auth.ts.
 */
import { eq, isNull, isNotNull, and, inArray } from "drizzle-orm";
import { apiKeys } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiIngestAuthQueries } from "../areas/api-ingest-auth.js";

export function pgApiIngestAuth(db: PgDb): ApiIngestAuthQueries {
  return {
    async findActiveKeyByHash(keyHash) {
      const rows = await db
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
          kind: apiKeys.kind,
          allowedOrigins: apiKeys.allowedOrigins,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyHash, keyHash),
            isNull(apiKeys.revokedAt),
            // Only ingestion keys authenticate ingestion. Admin and instance
            // keys (instance keys have no tenant) are stored and listed only.
            inArray(apiKeys.kind, ["publishable", "secret"]),
            isNotNull(apiKeys.tenantId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || row.tenantId === null) return null;
      return { ...row, tenantId: row.tenantId };
    },

    async touchKeyLastUsed(apiKeyId, at) {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
    },
  };
}
