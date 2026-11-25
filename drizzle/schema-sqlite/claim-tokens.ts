import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One-time claim tokens for the first account of an instance.
 *
 * Instance-wide (not product-owned), so no tenant_id.
 * - Only the SHA-256 hash (hex) of the token is stored; the raw token is in
 *   the claim URL only.
 * - Node mints one at boot while no user exists (24 hour expiry, older
 *   unconsumed tokens deleted); on Workers the deploy CLI mints it.
 * - Single-use: consumed via atomic CAS (UPDATE WHERE consumed_at IS NULL).
 */
export const claimTokens = sqliteTable(
  "claim_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("uq_claim_tokens_token_hash").on(table.tokenHash)],
);
