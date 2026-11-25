import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Instance-wide settings (one row per key), managed by instance admins.
 * Not product-owned, so no tenant_id.
 */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
});
