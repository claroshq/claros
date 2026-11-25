import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { topics } from "./topics.js";

/**
 * A contact's explicit status for one topic. No row means the topic's
 * default_subscribed applies.
 */
export const contactTopics = pgTable(
  "contact_topics",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id),
    status: text("status").notNull(), // subscribed|unsubscribed
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    source: text("source"), // identify|page|one_click|api
  },
  (table) => [
    primaryKey({ name: "contact_topics_pkey", columns: [table.contactId, table.topicId] }),
    index("idx_contact_topics_tenant_topic").on(table.tenantId, table.topicId),
  ],
);
