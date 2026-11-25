import { pgTable, uuid, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

/**
 * Outbound webhooks (G5) and the analytics sink (G30).
 *
 * webhook_endpoints: one row per receiver of a product. kind 'webhook' is a
 * signed (Standard Webhooks) JSON receiver subscribed to `events`; kind
 * 'analytics' is the product's analytics sink (at most one, slug
 * 'analytics'), whose `config` names the sink ('statsraven' | 'webhook') and
 * which receives the fixed analytics event set. `secret` is the signing
 * secret (webhook) or ingest token (statsraven), encrypted at rest.
 *
 * webhook_outbox: one row per (event, endpoint), written in the same atomic
 * unit as the state change it reports. status: pending | delivered | dead.
 * Delivery retries with backoff (1 minute doubling to 12 hours) until
 * MAX attempts, then dead. dedup_key makes batched events (the
 * pending-approval ping) unique per product, endpoint and window.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("webhook"), // webhook|analytics
    url: text("url").notNull(),
    secret: text("secret"), // encrypted envelope (adapters/crypto)
    events: jsonb("events").$type<string[]>().notNull(),
    config: jsonb("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("uq_webhook_endpoints_tenant_slug").on(table.tenantId, table.slug)],
);

export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    endpointId: uuid("endpoint_id").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending|delivered|dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    dedupKey: text("dedup_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_webhook_outbox_due")
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index("idx_webhook_outbox_tenant_event").on(table.tenantId, table.event, table.createdAt),
    uniqueIndex("uq_webhook_outbox_dedup")
      .on(table.tenantId, table.endpointId, table.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
  ],
);
