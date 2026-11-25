/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-kb.ts.
 *
 * D1 has no vector index: searchSimilarEntries loads the tenant's active
 * entries that have an embedding (JSON array) and ranks them by cosine
 * similarity computed in JS (similarity = 1 - cosine distance, closest
 * first, top `limit`), like pgvector's `<=>`. The caller applies the
 * similarity floor. A dimension mismatch throws, as pgvector does.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerContextKbQueries, WorkerKbSimilarityRow } from "../areas/worker-context-kb.js";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`different vector dimensions ${a.length} and ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

export function d1WorkerContextKb(db: D1Db): WorkerContextKbQueries {
  return {
    async findEmbeddedEntryByTitle({ tenantId, title }) {
      const rows = await db
        .select({ id: kbEntries.id, title: kbEntries.title, content: kbEntries.content })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            eq(kbEntries.title, title),
            eq(kbEntries.isActive, true),
            isNotNull(kbEntries.embedding),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async searchSimilarEntries({ tenantId, queryVector, limit, excludeId }) {
      const rows = await db
        .select({
          id: kbEntries.id,
          title: kbEntries.title,
          content: kbEntries.content,
          embedding: kbEntries.embedding,
        })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            eq(kbEntries.isActive, true),
            isNotNull(kbEntries.embedding),
            excludeId ? ne(kbEntries.id, excludeId) : undefined,
          ),
        );
      const scored = rows.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        similarity: cosineSimilarity(r.embedding as number[], queryVector),
      }));
      // Closest first; NaN (zero-length vectors) last, as pg orders NaN distances.
      scored.sort((x, y) => {
        const xs = Number.isNaN(x.similarity) ? -Infinity : x.similarity;
        const ys = Number.isNaN(y.similarity) ? -Infinity : y.similarity;
        return ys - xs;
      });
      return scored.slice(0, limit).map(
        (r): WorkerKbSimilarityRow => ({
          id: r.id,
          title: r.title,
          content: r.content,
          similarity: String(r.similarity),
        }),
      );
    },
  };
}
