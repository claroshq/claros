/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-webhooks.ts.
 *
 * Writes and the config_version bump are one D1 batch. The batch runs the
 * guarded write first; the bump is guarded by the same row existing (create,
 * update) or by the delete having removed it (checked from the returned rows),
 * so a refused write never bumps the version.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { tenants, webhookEndpoints, webhookOutbox } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
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

export function d1ApiWebhooks(db: D1Db): ApiWebhooksQueries {
  const bump = (tenantId: string) =>
    db.update(tenants).set({ configVersion: sql`${tenants.configVersion} + 1` }).where(eq(tenants.id, tenantId));

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
      const id = crypto.randomUUID();
      // The unique index (tenant_id, slug) refuses a duplicate; the bump only
      // applies when the row with this id exists.
      const [inserted] = await db.batch([
        db
          .insert(webhookEndpoints)
          .values({
            id,
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
          .returning(COLUMNS),
        db
          .update(tenants)
          .set({ configVersion: sql`${tenants.configVersion} + 1` })
          .where(and(eq(tenants.id, input.tenantId), sql`EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ${id})`)),
      ]);
      return inserted[0] ? toRow(inserted[0]) : null;
    },

    async updateEndpoint({ tenantId, slug, patch, now }) {
      const set: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: now };
      if (patch.url !== undefined) set.url = patch.url;
      if (patch.events !== undefined) set.events = patch.events;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (patch.config !== undefined) set.config = patch.config;
      if (patch.secret !== undefined) set.secret = patch.secret;
      const where = and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.slug, slug), eq(webhookEndpoints.kind, "webhook"));
      const [updated] = await db.batch([
        db.update(webhookEndpoints).set(set).where(where).returning(COLUMNS),
        db
          .update(tenants)
          .set({ configVersion: sql`${tenants.configVersion} + 1` })
          .where(
            and(
              eq(tenants.id, tenantId),
              sql`EXISTS (SELECT 1 FROM webhook_endpoints WHERE tenant_id = ${tenantId} AND slug = ${slug} AND kind = 'webhook')`,
            ),
          ),
      ]);
      return updated[0] ? toRow(updated[0]) : null;
    },

    async deleteEndpoint({ tenantId, slug }) {
      const found = await db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.slug, slug), eq(webhookEndpoints.kind, "webhook")))
        .limit(1);
      if (!found[0]) return false;
      const endpointId = found[0].id;
      const [deleted] = await db.batch([
        db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.tenantId, tenantId))).returning({ id: webhookEndpoints.id }),
        db
          .delete(webhookOutbox)
          .where(and(eq(webhookOutbox.tenantId, tenantId), eq(webhookOutbox.endpointId, endpointId), eq(webhookOutbox.status, "pending"))),
        bump(tenantId),
      ]);
      return deleted.length > 0;
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
