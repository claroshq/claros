/**
 * Postgres implementation of the queries used by packages/api/src/http/ingest-auth.ts.
 */
import { eq, isNull, and } from "drizzle-orm";
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
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      return rows[0] ?? null;
    },

    async touchKeyLastUsed(apiKeyId, at) {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
    },
  };
}
