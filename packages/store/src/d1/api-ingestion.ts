/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingestion.ts.
 *
 * Orderings put NULL created_at last, as Postgres ASC does.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { apiKeys, contacts, events } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiIngestionQueries } from "../areas/api-ingestion.js";

const KEY_COLUMNS = {
  id: apiKeys.id,
  kind: apiKeys.kind,
  prefix: apiKeys.prefix,
  label: apiKeys.label,
  allowedOrigins: apiKeys.allowedOrigins,
  scopes: apiKeys.scopes,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
} as const;

export function d1ApiIngestion(db: D1Db): ApiIngestionQueries {
  return {
    async listKeys(tenantId) {
      return db
        .select(KEY_COLUMNS)
        .from(apiKeys)
        .where(eq(apiKeys.tenantId, tenantId))
        .orderBy(sql`${apiKeys.createdAt} IS NULL`, apiKeys.createdAt);
    },

    async createKey(key) {
      const [row] = await db
        .insert(apiKeys)
        .values({
          tenantId: key.tenantId,
          keyHash: key.keyHash,
          prefix: key.prefix,
          label: key.label,
          kind: key.kind,
          allowedOrigins: key.allowedOrigins,
          scopes: key.scopes ?? null,
        })
        .returning(KEY_COLUMNS);
      return row;
    },

    async findKeyKind(tenantId, keyId) {
      const existing = await db
        .select({ id: apiKeys.id, kind: apiKeys.kind })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
        .limit(1);
      return existing[0] ?? null;
    },

    async updateKey(keyId, updates) {
      const [row] = await db
        .update(apiKeys)
        .set(updates as Record<string, unknown>)
        .where(eq(apiKeys.id, keyId))
        .returning(KEY_COLUMNS);
      return row;
    },

    async findKeyRevocation(tenantId, keyId) {
      const existing = await db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
        .limit(1);
      return existing[0] ?? null;
    },

    async revokeKey(keyId, at) {
      await db.update(apiKeys).set({ revokedAt: at }).where(eq(apiKeys.id, keyId));
    },

    async findLastEventSince(tenantId, since) {
      const lastRows = await db
        .select({
          type: events.type,
          eventName: events.eventName,
          receivedAt: events.receivedAt,
          externalId: contacts.externalId,
        })
        .from(events)
        .innerJoin(contacts, eq(events.contactId, contacts.id))
        .where(and(eq(events.tenantId, tenantId), gte(events.receivedAt, since)))
        .orderBy(desc(events.receivedAt))
        .limit(1);
      return lastRows[0] ?? null;
    },

    async countEventsSince(tenantId, since) {
      const countRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(events)
        .where(and(eq(events.tenantId, tenantId), gte(events.receivedAt, since)));
      return countRows[0]?.count;
    },
  };
}
