import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

export const transportConfigs = sqliteTable("transport_configs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  provider: text("provider").notNull(), // ses|resend|smtp
  config: text("config", { mode: "json" }).notNull(), // encrypted credentials
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  dkimVerified: integer("dkim_verified", { mode: "boolean" }).default(false),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  dailyLimit: integer("daily_limit"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
});
