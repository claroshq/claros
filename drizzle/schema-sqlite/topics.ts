import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/** Topics: the subscription categories of a product (see drizzle/schema/topics.ts). */
export const topics = sqliteTable(
  "topics",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // marketing|lifecycle|transactional
    description: text("description"),
    defaultSubscribed: integer("default_subscribed", { mode: "boolean" }).notNull().default(true),
    /** P5b: the topic only mirrors a consent kept elsewhere; no flow may send on it. */
    mirrorOnly: integer("mirror_only", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("uq_topics_tenant_slug").on(table.tenantId, table.slug)],
);
