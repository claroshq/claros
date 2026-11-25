import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Embedding provider credentials, encrypted at rest with ENCRYPTION_KEY.
 *
 * Separate from llm_configs so a product can draft with one provider
 * (Anthropic, which has no embeddings API) and embed its knowledge base with
 * another (OpenAI or any OpenAI-compatible /embeddings endpoint). One active
 * row per tenant, same pattern as llm_configs and transport_configs.
 *
 * Decrypted shape: { "apiKey": "...", "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" }
 *
 * provider values: openai | custom
 *   - "openai" implies its base URL and model when not overridden.
 *   - "custom" requires an explicit baseUrl and model.
 *   The endpoint must return 1536-dimension vectors (kb_entries.embedding).
 */
export const embeddingConfigs = pgTable(
  "embedding_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    provider: text("provider").notNull(), // openai|custom
    config: text("config").notNull(), // encrypted JSON envelope (EncryptedEnvelope)
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_embedding_configs_tenant_active").on(table.tenantId, table.isActive)],
);
