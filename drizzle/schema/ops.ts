import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Operational events and alerts (G25). Instance-level, not product-owned:
 * tenant_id names the product an event is about, when it is about one, and
 * is not a scope (instance admins see every row).
 *
 * ops_events: one row per recorded failure (dead job, job exception, late
 * tick, send error rate, missing configuration, webhook failures, LLM error
 * rate). severity: warning | error | critical. fingerprint groups repeats
 * (kind + product + the message with ids, numbers and timestamps stripped).
 * Kept 30 days (retention runs in the daily digest tick).
 *
 * ops_alerts: one row per fingerprint, the state alert mail works from.
 * status: open | resolved. count is the number of occurrences since the
 * alert opened; notified_count is the count at the last alert mail, so a
 * repeat mail can say "N more since". severity and message are the latest
 * occurrence's.
 */
export const opsEvents = pgTable(
  "ops_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    tenantId: uuid("tenant_id"),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(), // warning|error|critical
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    context: jsonb("context"),
  },
  (table) => [
    index("idx_ops_events_fingerprint_at").on(table.fingerprint, table.at),
    index("idx_ops_events_at").on(table.at),
  ],
);

export const opsAlerts = pgTable("ops_alerts", {
  fingerprint: text("fingerprint").primaryKey(),
  kind: text("kind").notNull(),
  tenantId: uuid("tenant_id"),
  severity: text("severity").notNull(), // warning|error|critical
  message: text("message").notNull(),
  firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(1),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  notifiedCount: integer("notified_count").notNull().default(0),
  status: text("status").notNull().default("open"), // open|resolved
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
});
