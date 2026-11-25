import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Instance-wide settings (one row per key), managed by instance admins.
 * Not product-owned, so no tenant_id.
 */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
