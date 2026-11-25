/**
 * API keys for event ingestion authentication.
 *
 * Each tenant gets one or more write keys. Incoming track/identify requests
 * carry `Authorization: Bearer <write_key>` (server-side) or the key in the
 * request body (browser snippet, where a header would force a CORS preflight).
 * We store only the SHA-256 hash; the raw key is shown once at creation and
 * never stored.
 *
 * Key kinds:
 * - "publishable": safe to embed in a public web page. Write-only by design:
 *   it authenticates /v1/track and /v1/identify and nothing else, which no
 *   reader endpoint exists for. Carries an optional per-key origin allowlist
 *   (allowed_origins) and a stricter rate limit. Browser-facing.
 * - "secret": server-side. No origin check, higher rate limit. Must never
 *   be embedded in a browser; the CORS layer deliberately does not echo an
 *   Origin for secret keys, so browsers cannot use them cross-origin.
 * - "admin": management key of one product (prefix clr_ak_). Authenticates
 *   the management routes its scopes allow; never ingestion.
 * - "instance": instance key (tenant_id null). Stored and listed only.
 *
 * The `prefix` column (first 8 chars of the raw key) enables masked display
 * in the dashboard without exposing the full key.
 *
 * [impl] Added in task 7 (event ingestion API) - not in the original spec's
 * section 8, but required by Appendix C's authentication contract.
 * kind/allowed_origins added with the Integrate screen (Phase 5).
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Null for instance keys (kind "instance"), which are not bound to a product.
    tenantId: text("tenant_id").references(() => tenants.id),
    keyHash: text("key_hash").notNull(), // SHA-256 hex of the raw key
    prefix: text("prefix").notNull(), // first 8 chars for masked display
    label: text("label"), // human-friendly name ("Production backend")
    // publishable|secret|admin|instance. admin and instance keys are stored
    // and listed only; they do not authenticate ingestion. Default 'secret' preserves the behavior of keys
    // created before this column existed (they were server-side write keys).
    kind: text("kind").notNull().default("secret"),
    // Publishable keys only: allowed browser Origins (scheme + host + port,
    // e.g. "https://app.example.com"). null/empty = any origin is allowed
    // (write-only capability makes this safe; the allowlist is abuse friction,
    // not the security boundary). Ignored for secret keys.
    allowedOrigins: text("allowed_origins", { mode: "json" }).$type<string[]>(),
    /** Admin keys only (G1): granted management scopes. Null for every other kind. */
    scopes: text("scopes", { mode: "json" }).$type<string[]>(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }), // null = active
  },
  (table) => [
    // Every ingestion request looks up by key_hash WHERE revoked_at IS NULL.
    // Partial index keeps the lookup fast and skips revoked rows.
    uniqueIndex("uq_api_keys_hash_active")
      .on(table.keyHash)
      .where(sql`revoked_at IS NULL`),
    // Dashboard listing: all keys for a tenant (active and revoked)
    index("idx_api_keys_tenant").on(table.tenantId),
  ],
);
