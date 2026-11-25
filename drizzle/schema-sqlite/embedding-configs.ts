import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/**
 * Embedding provider credentials, encrypted at rest with ENCRYPTION_KEY.
 * See drizzle/schema/embedding-configs.ts for the shape and rules.
 */
export const embeddingConfigs = sqliteTable(
  "embedding_configs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    provider: text("provider").notNull(), // openai|custom
    config: text("config").notNull(), // encrypted JSON envelope (EncryptedEnvelope)
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [index("idx_embedding_configs_tenant_active").on(table.tenantId, table.isActive)],
);
