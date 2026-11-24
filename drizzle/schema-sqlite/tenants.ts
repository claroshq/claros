import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  plan: text("plan").default("free"), // free|pro|enterprise
  settings: text("settings", { mode: "json" }), // all tenant config (throttle, lifecycle, etc.)
  businessModel: text("business_model"), // preview_free|freemium|time_limited_trial
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
});
