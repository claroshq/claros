import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").default("member").notNull(), // owner|member
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    /** Soft-delete: set when a member is removed. Sessions are hard-deleted
     *  for immediate access revocation, but the user row persists for
     *  attribution (approvals, sent messages). */
    deactivatedAt: integer("deactivated_at", { mode: "timestamp_ms" }),
    /** Email change flow: the new address pending verification. */
    pendingEmail: text("pending_email"),
    /** SHA-256 hash of the email-change verification token. */
    pendingEmailTokenHash: text("pending_email_token_hash"),
    /** Expiry for the pending email change (24 hours from request). */
    pendingEmailExpiresAt: integer("pending_email_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_users_tenant_email").on(table.tenantId, table.email),
  ]
);
