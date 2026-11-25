import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Product memberships: which products (tenants) a user may act on, and with
 * which role. users.tenant_id stays the user's home product (NOT NULL in this
 * release) and users.role the role there, which access checks read as in
 * v0.6; every other product needs a membership row. Writers keep the home
 * product's membership row in step with users.role.
 */
export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    role: text("role").notNull(), // owner|member
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ name: "memberships_pkey", columns: [table.userId, table.tenantId] }),
    index("idx_memberships_tenant").on(table.tenantId),
  ],
);
