import { pgTable, uuid, text, timestamp, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Tenants. User-facing name: "product". One instance serves many products.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    plan: text("plan").default("free"), // free|pro|enterprise
    settings: jsonb("settings"), // all tenant config (throttle, lifecycle, etc.)
    businessModel: text("business_model"), // preview_free|freemium|time_limited_trial
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /** Set when the product is archived: reads stay allowed, dashboard writes answer 409. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Optional public host name of the product (unique across the instance). */
    publicHost: text("public_host"),
    /** Default locale of the product (e.g. "en"), or null. */
    locale: text("locale"),
    /** Bumped on configuration changes; lets caches tell stale config apart. */
    configVersion: integer("config_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uq_tenants_public_host")
      .on(table.publicHost)
      .where(sql`public_host IS NOT NULL`),
  ],
);
