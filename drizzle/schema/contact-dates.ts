import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/**
 * Date traits of a contact (G3), one row per declared date trait
 * (settings.date_traits) that holds a parseable date. Maintained on identify;
 * read by the date-trigger scan, which looks up contacts by
 * (tenant, property, value) instead of scanning contact properties.
 */
export const contactDates = pgTable(
  "contact_dates",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    property: text("property").notNull(),
    value: timestamp("value", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ name: "contact_dates_pkey", columns: [table.tenantId, table.contactId, table.property] }),
    index("idx_contact_dates_scan").on(table.tenantId, table.property, table.value),
  ],
);
