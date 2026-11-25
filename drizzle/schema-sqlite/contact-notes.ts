import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/** Notes a team member wrote about a contact. See ../schema/contact-notes.ts. */
export const contactNotes = sqliteTable(
  "contact_notes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_contact_notes_contact").on(table.tenantId, table.contactId, table.createdAt),
  ],
);
