import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/**
 * LLM provider credentials, encrypted at rest with ENCRYPTION_KEY.
 *
 * [impl] Added in task 11. BYO LLM key for flow compilation and content drafting.
 * Follows the transport_configs pattern: one active config per tenant.
 *
 * The `config` column stores an encrypted JSON envelope (see @claros/adapters crypto module).
 * Decrypted shape: { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o" }
 *
 * provider values: openai | anthropic | ollama | custom
 *   - "openai" and "anthropic" imply their standard base URLs if not overridden.
 *   - "ollama" implies http://localhost:11434/v1 if not overridden.
 *   - "custom" requires an explicit baseUrl.
 *   All providers use the OpenAI-compatible chat completions API shape.
 */
export const llmConfigs = sqliteTable("llm_configs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  provider: text("provider").notNull(), // openai|anthropic|ollama|custom
  config: text("config").notNull(), // encrypted JSON envelope (EncryptedEnvelope)
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
});
