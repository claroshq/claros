import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Topics: the subscription categories of a product (G8a). A flow may carry a
 * topic; its messages are then gated by the contact's status for that topic
 * (contact_topics) at send time, after the suppression list.
 *
 * kind: marketing | lifecycle | transactional. Transactional topics ignore
 * topic unsubscribes (never suppressions), carry no List-Unsubscribe headers
 * (D18) and are the only mail a `cloudflare` transport may send (D16).
 */
export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // marketing|lifecycle|transactional
    description: text("description"),
    defaultSubscribed: boolean("default_subscribed").notNull().default(true),
    /** P5b: the topic only mirrors a consent kept elsewhere; no flow may send on it. */
    mirrorOnly: boolean("mirror_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("uq_topics_tenant_slug").on(table.tenantId, table.slug)],
);
