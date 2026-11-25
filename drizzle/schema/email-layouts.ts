import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Custom email templates per product (the Templates page). A template is
 * the HTML document every email of the product is sent in, with
 * placeholders ({{body}}, {{compliance_footer}}, ...) filled at send time:
 * see packages/core/src/layout-templates.ts. Built-in templates are code,
 * not rows. The product's settings.brand.template names the one in use
 * (a built-in key or the id of a row here).
 *
 * width: narrow | wide. based_on: the built-in key or template id the
 * template was copied from, for display only.
 */
export const emailLayouts = pgTable(
  "email_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    width: text("width").notNull(),
    source: text("source").notNull(),
    basedOn: text("based_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_email_layouts_tenant_updated").on(table.tenantId, table.updatedAt)],
);
