import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

export const kbEntries = sqliteTable(
  "kb_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentType: text("content_type").default("markdown"), // markdown|html|text
    source: text("source").default("manual"), // manual|crawl|upload
    sourceUrl: text("source_url"), // for crawled content
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    // Optional embedding (JSON array of numbers). SQLite has no vector index;
    // the D1 store searches the knowledge base with FTS5 (kb_fts) and, for
    // small knowledge bases, cosine similarity computed in code.
    embedding: text("embedding", { mode: "json" }).$type<number[]>(),
    // [impl] task 22: embedding lifecycle state tracking.
    // Mirrors the compile_status/compile_error pattern on the flows table.
    // null = never enqueued; 'pending' = job enqueued, not yet written;
    // 'failed' = permanently failed (dimensionality mismatch, bad model, etc.)
    // 'failed' entries carry the reason in embedding_error.
    // When embedding is non-NULL, embedding_status is implicitly 'done' (no column
    // needed: the vector itself is the evidence).
    embeddingStatus: text("embedding_status"), // null|pending|failed
    embeddingError: text("embedding_error"),   // human-readable reason when failed
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    // List endpoint cursor pagination: ORDER BY (created_at, id) per tenant.
    index("idx_kb_entries_tenant_created").on(table.tenantId, table.createdAt, table.id),
  ]
);
