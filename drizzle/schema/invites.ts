import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Team invites.
 *
 * An invite is a one-time-use token that lets a new person join a tenant.
 * The token is generated as 32 random bytes (URL-safe base64); only the
 * SHA-256 hash is stored here. The raw token goes in the invite URL.
 *
 * Lifecycle:
 *   - Created by an owner via POST /v1/team/invites.
 *   - If a transport is configured, a branded email is sent. Either way,
 *     the raw invite URL is returned in the API response for copy-paste.
 *   - Accepted via POST /invite/accept (public route, like magic link verify).
 *   - Single-use: atomic CAS on accepted_at.
 *   - 7-day TTL.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** The email address being invited. Becomes the user's login email. */
    email: text("email").notNull(),
    /** Role the invitee will receive on acceptance. */
    role: text("role").default("member").notNull(), // owner|member
    /** SHA-256 hash of the invite token. The raw token is in the URL. */
    tokenHash: text("token_hash").notNull(),
    /** Who created this invite. */
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set atomically on acceptance; prevents reuse. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_invites_token_hash").on(table.tokenHash),
    index("idx_invites_tenant").on(table.tenantId),
  ]
);
