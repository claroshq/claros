import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Operational events and alerts (G25); see drizzle/schema/ops.ts. */
export const opsEvents = sqliteTable(
  "ops_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    tenantId: text("tenant_id"),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(), // warning|error|critical
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    context: text("context", { mode: "json" }),
  },
  (table) => [
    index("idx_ops_events_fingerprint_at").on(table.fingerprint, table.at),
    index("idx_ops_events_at").on(table.at),
  ],
);

export const opsAlerts = sqliteTable("ops_alerts", {
  fingerprint: text("fingerprint").primaryKey(),
  kind: text("kind").notNull(),
  tenantId: text("tenant_id"),
  severity: text("severity").notNull(), // warning|error|critical
  message: text("message").notNull(),
  firstAt: integer("first_at", { mode: "timestamp_ms" }).notNull(),
  lastAt: integer("last_at", { mode: "timestamp_ms" }).notNull(),
  count: integer("count").notNull().default(1),
  lastNotifiedAt: integer("last_notified_at", { mode: "timestamp_ms" }),
  notifiedCount: integer("notified_count").notNull().default(0),
  status: text("status").notNull().default("open"), // open|resolved
  mutedUntil: integer("muted_until", { mode: "timestamp_ms" }),
});
