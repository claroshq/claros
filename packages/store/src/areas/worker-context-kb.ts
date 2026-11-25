/**
 * Queries used by packages/worker/src/context-kb.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-context-kb.ts (Postgres) and, later,
 * ../d1/worker-context-kb.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A KB entry candidate with its cosine similarity (as returned by the driver, a numeric string). */
export interface WorkerKbSimilarityRow {
  id: string;
  title: string;
  content: string;
  similarity: string;
}

export interface WorkerContextKbQueries {
  /**
   * An active, embedded KB entry of the tenant with this exact
   * (case-sensitive) title, or null.
   */
  findEmbeddedEntryByTitle(input: {
    tenantId: string;
    title: string;
  }): Promise<{ id: string; title: string; content: string } | null>;
  /**
   * The tenant's active, embedded KB entries nearest to the query vector by
   * cosine distance (closest first), optionally excluding one entry id, with
   * similarity = 1 - cosine distance. Postgres: pgvector `<=>`.
   */
  searchSimilarEntries(input: {
    tenantId: string;
    queryVector: number[];
    limit: number;
    excludeId: string | null;
  }): Promise<WorkerKbSimilarityRow[]>;
}
