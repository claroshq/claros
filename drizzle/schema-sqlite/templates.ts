import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    variables: text("variables", { mode: "json" }).$type<string[]>(), // available merge variables
    category: text("category"), // nurture|curriculum|upgrade|critical
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_templates_tenant_slug").on(table.tenantId, table.slug),
  ]
);
