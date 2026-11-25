import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
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
    // 'skipped' = no vector and no job queued: no embedding provider when the
    // job ran, or vectors dropped after an embedding model change.
    // When embedding is non-NULL, embedding_status is implicitly 'done' (no column
    // needed: the vector itself is the evidence).
    embeddingStatus: text("embedding_status"), // null|pending|failed|skipped
    embeddingError: text("embedding_error"),   // human-readable reason when failed
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    /** G18: free-form grouping used by kb_select. */
    category: text("category"),
    /** G15: stable key from the source system; unique per product. */
    externalKey: text("external_key"),
    /** G18: the entry's structured source data (read-only reference). */
    data: text("data", { mode: "json" }),
    /** G18: pinned entries always enter the brain context (within a budget). */
    pinned: integer("pinned", { mode: "boolean" }).default(false).notNull(),
    /** G15: when the import last wrote this row. */
    importedAt: integer("imported_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    // List endpoint cursor pagination: ORDER BY (created_at, id) per tenant.
    index("idx_kb_entries_tenant_created").on(table.tenantId, table.createdAt, table.id),
    uniqueIndex("uq_kb_entries_external_key")
      .on(table.tenantId, table.externalKey)
      .where(sql`external_key IS NOT NULL`),
    index("idx_kb_entries_category").on(table.tenantId, table.category),
  ]
);
