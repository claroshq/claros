import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Magic link tokens for passwordless login.
 *
 * Security model:
 * - Raw token (32 random bytes, URL-safe base64) is sent in the magic link URL.
 * - Only the SHA-256 hash of the token is stored here (`token_hash`).
 * - A DB leak does not expose usable tokens.
 * - Single-use: verified via atomic CAS (UPDATE WHERE consumed_at IS NULL).
 * - 10-minute TTL.
 * - user_id cascades: deleting a user removes all their tokens.
 */
export const magicLinkTokens = sqliteTable(
  "magic_link_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_magic_link_tokens_hash").on(table.tokenHash),
  ]
);
