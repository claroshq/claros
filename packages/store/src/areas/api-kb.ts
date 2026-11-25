/**
 * Queries used by packages/api/src/routes/kb.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-kb.ts (Postgres) and, later,
 * ../d1/api-kb.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A kb_entries row (all columns). */
export interface ApiKbEntryRow {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  contentType: string | null;
  source: string | null;
  sourceUrl: string | null;
  tags: string[] | null;
  embedding: number[] | null;
  embeddingStatus: string | null;
  embeddingError: string | null;
  isActive: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Fields a PATCH may set on an entry; absent keys are left unchanged. */
export interface ApiKbEntryPatch {
  updatedAt: Date;
  title?: string;
  content?: string;
  contentType?: string;
  source?: string;
  sourceUrl?: string;
  tags?: string[];
  isActive?: boolean;
  embeddingStatus?: string;
  embeddingError?: null;
}

export interface ApiKbQueries {
  /**
   * Insert an entry and return the full row. embeddingStatus is only written
   * when given (absent leaves the column default).
   */
  createEntry(args: {
    tenantId: string;
    title: string;
    content: string;
    contentType: string;
    source: string;
    sourceUrl: string | null;
    tags: string[] | null;
    embeddingStatus?: "pending";
    isActive: boolean;
  }): Promise<ApiKbEntryRow | undefined>;
  /**
   * One page of the tenant's entries ordered by (created_at truncated to ms, id),
   * starting after the cursor when given. Returns up to `limit` rows.
   */
  listEntries(args: {
    tenantId: string;
    includeInactive: boolean;
    cursor: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<ApiKbEntryRow[]>;
  /** The tenant's entry by id, or null. */
  findEntry(args: { tenantId: string; id: string }): Promise<ApiKbEntryRow | null>;
  /** Apply a partial update to the tenant's entry and return the updated row. */
  updateEntry(args: { tenantId: string; id: string; patch: ApiKbEntryPatch }): Promise<ApiKbEntryRow | undefined>;
  /** Hard delete the tenant's entry. */
  deleteEntry(args: { tenantId: string; id: string }): Promise<void>;
  /**
   * Ids of the tenant's entries that need (re-)embedding: no embedding and
   * status null, 'failed', or 'pending' older than the orphan threshold
   * (measured against the database clock).
   */
  listReEmbedCandidateIds(args: { tenantId: string; orphanThresholdMinutes: number }): Promise<string[]>;
  /** Set embedding_status = 'pending', clear embedding_error for the tenant's given entries. */
  markEntriesPendingEmbedding(args: { tenantId: string; ids: string[]; now: Date }): Promise<void>;
}
