import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/**
 * Notes a team member wrote about a contact (People page). Free text for
 * the team only: never read by the engine, never sent to the LLM.
 * author_user_id has no foreign key: notes outlive a removed member, and the
 * author is shown when the user row still exists. Erased with the contact.
 */
export const contactNotes = pgTable(
  "contact_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    authorUserId: uuid("author_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_contact_notes_contact").on(table.tenantId, table.contactId, table.createdAt),
  ],
);
