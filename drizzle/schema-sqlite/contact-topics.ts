import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { topics } from "./topics.js";

/** A contact's explicit status for one topic (see drizzle/schema/contact-topics.ts). */
export const contactTopics = sqliteTable(
  "contact_topics",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id),
    status: text("status").notNull(), // subscribed|unsubscribed
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    source: text("source"), // identify|page|one_click|api
  },
  (table) => [
    primaryKey({ name: "contact_topics_pkey", columns: [table.contactId, table.topicId] }),
    index("idx_contact_topics_tenant_topic").on(table.tenantId, table.topicId),
  ],
);
