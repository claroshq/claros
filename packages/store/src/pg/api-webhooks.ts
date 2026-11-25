/**
 * Postgres implementation of the queries in ../areas/api-webhooks.ts.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { tenants, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiWebhooksQueries, WebhookEndpointRow } from "../areas/api-webhooks.js";

const COLUMNS = {
  id: webhookEndpoints.id,
  tenantId: webhookEndpoints.tenantId,
  slug: webhookEndpoints.slug,
  kind: webhookEndpoints.kind,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  config: webhookEndpoints.config,
  enabled: webhookEndpoints.enabled,
  secret: webhookEndpoints.secret,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
} as const;

type Raw = { [K in keyof typeof COLUMNS]: unknown };

function toRow(r: Raw): WebhookEndpointRow {
  return {
    id: r.id as string,
    tenantId: r.tenantId as string,
    slug: r.slug as string,
    kind: r.kind as string,
    url: r.url as string,
    events: Array.isArray(r.events) ? (r.events as string[]) : [],
    config: r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : null,
    enabled: r.enabled === true,
    hasSecret: typeof r.secret === "string" && r.secret.length > 0,
    createdAt: (r.createdAt as Date | null) ?? null,
    updatedAt: (r.updatedAt as Date | null) ?? null,
  };
}

async function bumpVersion(tx: PgDb, tenantId: string): Promise<void> {
  await tx.update(tenants).set({ configVersion: sql`${tenants.configVersion} + 1` }).where(eq(tenants.id, tenantId));
}

export function pgApiWebhooks(db: PgDb): ApiWebhooksQueries {
  return {
    async listEndpoints(tenantId) {
      const rows = await db.select(COLUMNS).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId)).orderBy(asc(webhookEndpoints.slug));
      return rows.map(toRow);
    },

    async findEndpoint({ tenantId, slug }) {
      const rows = await db
        .select(COLUMNS)
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.slug, slug)))
        .limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async createEndpoint(input) {
      return db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as PgDb;
        const rows = await tx
          .insert(webhookEndpoints)
          .values({
            tenantId: input.tenantId,
            slug: input.slug,
            kind: "webhook",
            url: input.url,
            events: input.events,
            config: input.config,
            enabled: input.enabled,
            secret: input.secret,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
          .returning(COLUMNS);
        if (!rows[0]) return null;
        await bumpVersion(tx, input.tenantId);
        return toRow(rows[0]);
      });
    },

    async updateEndpoint({ tenantId, slug, patch, now }) {
      return db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as PgDb;
        const set: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: now };
        if (patch.url !== undefined) set.url = patch.url;
        if (patch.events !== undefined) set.events = patch.events;
        if (patch.enabled !== undefined) set.enabled = patch.enabled;
        if (patch.config !== undefined) set.config = patch.config;
        if (patch.secret !== undefined) set.secret = patch.secret;
        const rows = await tx
          .update(webhookEndpoints)
          .set(set)
          .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.slug, slug), eq(webhookEndpoints.kind, "webhook")))
          .returning(COLUMNS);
        if (!rows[0]) return null;
        await bumpVersion(tx, tenantId);
        return toRow(rows[0]);
      });
    },

    async deleteEndpoint({ tenantId, slug }) {
      return db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as PgDb;
        const rows = await tx
          .delete(webhookEndpoints)
          .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.slug, slug), eq(webhookEndpoints.kind, "webhook")))
          .returning({ id: webhookEndpoints.id });
        if (!rows[0]) return false;
        await tx
          .delete(webhookOutbox)
          .where(and(eq(webhookOutbox.tenantId, tenantId), eq(webhookOutbox.endpointId, rows[0].id), eq(webhookOutbox.status, "pending")));
        await bumpVersion(tx, tenantId);
        return true;
      });
    },

    async listDeliveries({ tenantId, endpointId, limit }) {
      return db
        .select({
          id: webhookOutbox.id,
          event: webhookOutbox.event,
          status: webhookOutbox.status,
          attempts: webhookOutbox.attempts,
          nextAttemptAt: webhookOutbox.nextAttemptAt,
          lastError: webhookOutbox.lastError,
          createdAt: webhookOutbox.createdAt,
          deliveredAt: webhookOutbox.deliveredAt,
          payload: webhookOutbox.payload,
        })
        .from(webhookOutbox)
        .where(and(eq(webhookOutbox.tenantId, tenantId), eq(webhookOutbox.endpointId, endpointId)))
        .orderBy(desc(webhookOutbox.createdAt), desc(webhookOutbox.id))
        .limit(limit);
    },
  };
}
