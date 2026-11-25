import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/** Date traits of a contact (G3). See ../schema/contact-dates.ts. */
export const contactDates = sqliteTable(
  "contact_dates",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    property: text("property").notNull(),
    value: integer("value", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ name: "contact_dates_pkey", columns: [table.tenantId, table.contactId, table.property] }),
    index("idx_contact_dates_scan").on(table.tenantId, table.property, table.value),
  ],
);
