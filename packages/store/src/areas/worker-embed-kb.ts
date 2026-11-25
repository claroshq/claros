/**
 * Queries used by packages/worker/src/embed-kb.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-embed-kb.ts (Postgres) and, later,
 * ../d1/worker-embed-kb.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** The kb_entries fields the embedding worker reads. */
export interface WorkerEmbedKbEntry {
  id: string;
  tenantId: string;
  title: string;
  content: string;
}

export interface WorkerEmbedKbQueries {
  /** The tenant's KB entry by id, or null when it does not exist. */
  getKbEntry(tenantId: string, kbEntryId: string): Promise<WorkerEmbedKbEntry | null>;
  /** Store the embedding vector and clear embedding_status / embedding_error (vector = success). */
  saveEmbedding(tenantId: string, kbEntryId: string, embedding: number[]): Promise<void>;
  /** Record a permanent embedding failure: embedding_status = 'failed', embedding_error = reason (caller truncates). */
  markEmbeddingFailed(tenantId: string, kbEntryId: string, reason: string): Promise<void>;
}
