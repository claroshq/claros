import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const transportConfigs = pgTable("transport_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  provider: text("provider").notNull(), // ses|resend|smtp
  config: jsonb("config").notNull(), // encrypted credentials
  isActive: boolean("is_active").default(true),
  dkimVerified: boolean("dkim_verified").default(false),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  dailyLimit: integer("daily_limit"),
  /**
   * Transport kind: resend|smtp|cloudflare. Backfilled from provider by
   * migration 0025; nullable so writers from earlier releases keep working
   * (readers fall back to provider).
   */
  kind: text("kind"),
  /** Optional display name of the transport. */
  name: text("name"),
  /** Optional Reply-To address for mail sent through this transport. */
  replyTo: text("reply_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
