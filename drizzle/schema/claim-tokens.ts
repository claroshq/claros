import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
export const claimTokens = pgTable(
  "claim_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("uq_claim_tokens_token_hash").on(table.tokenHash)],
);
