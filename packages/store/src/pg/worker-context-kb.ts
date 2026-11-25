/**
 * Postgres implementation of the queries used by packages/worker/src/context-kb.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type {
  WorkerContextKbQueries,
  WorkerKbSimilarityRow,
} from "../areas/worker-context-kb.js";

export function pgWorkerContextKb(db: PgDb): WorkerContextKbQueries {
  return {
    async findEmbeddedEntryByTitle({ tenantId, title }) {
      const rows = await db.execute<{ id: string; title: string; content: string }>(sql`
        SELECT id, title, content
        FROM kb_entries
        WHERE tenant_id = ${tenantId}::uuid
          AND title = ${title}
          AND is_active = true
          AND embedding IS NOT NULL
        LIMIT 1
      `);

      if (rows.rows.length === 0) return null;
      return rows.rows[0]!;
    },

    async searchSimilarEntries({ tenantId, queryVector, limit, excludeId }) {
      // Format the query vector as a pgvector literal: '[f1,f2,...]'
      const vectorLiteral = `[${queryVector.join(",")}]`;

      // Uses the <=> (cosine distance) operator; similarity = 1 - distance.
      const rows = await db.execute<WorkerKbSimilarityRow & Record<string, unknown>>(sql`
        SELECT id, title, content,
               (1 - (embedding <=> ${vectorLiteral}::vector)) AS similarity
        FROM kb_entries
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
          AND embedding IS NOT NULL
          ${excludeId ? sql`AND id != ${excludeId}::uuid` : sql``}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `);
      return rows.rows;
    },
  };
}
