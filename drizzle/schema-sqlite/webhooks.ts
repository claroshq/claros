import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

/** Outbound webhooks (G5) and the analytics sink (G30); see drizzle/schema/webhooks.ts. */
export const webhookEndpoints = sqliteTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("webhook"), // webhook|analytics
    url: text("url").notNull(),
    secret: text("secret"),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    config: text("config", { mode: "json" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("uq_webhook_endpoints_tenant_slug").on(table.tenantId, table.slug)],
);

export const webhookOutbox = sqliteTable(
  "webhook_outbox",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    endpointId: text("endpoint_id").notNull(),
    event: text("event").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"), // pending|delivered|dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    lastError: text("last_error"),
    dedupKey: text("dedup_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
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
