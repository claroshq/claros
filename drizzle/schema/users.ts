import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").default("member").notNull(), // owner|member (role in the home product)
    /** Instance-wide role: "admin" or null. Admins act on every product as owner. */
    instanceRole: text("instance_role"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Soft-delete: set when a member is removed. Sessions are hard-deleted
     *  for immediate access revocation, but the user row persists for
     *  attribution (approvals, sent messages). */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    /** Email change flow: the new address pending verification. */
    pendingEmail: text("pending_email"),
    /** SHA-256 hash of the email-change verification token. */
    pendingEmailTokenHash: text("pending_email_token_hash"),
    /** Expiry for the pending email change (24 hours from request). */
    pendingEmailExpiresAt: timestamp("pending_email_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_users_tenant_email").on(table.tenantId, table.email),
  ]
);
