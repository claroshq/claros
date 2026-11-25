import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/** Custom email templates per product. See ../schema/email-layouts.ts. */
export const emailLayouts = sqliteTable(
  "email_layouts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    width: text("width").notNull(),
    source: text("source").notNull(),
    basedOn: text("based_on"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("idx_email_layouts_tenant_updated").on(table.tenantId, table.updatedAt)],
);
