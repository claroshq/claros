/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-embed-kb.ts.
 *
 * The embedding is stored as a JSON array of numbers (no vector type on SQLite).
 */
import { and, eq } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerEmbedKbQueries } from "../areas/worker-embed-kb.js";

export function d1WorkerEmbedKb(db: D1Db): WorkerEmbedKbQueries {
  return {
    async getKbEntry(tenantId, kbEntryId) {
      const rows = await db
        .select()
        .from(kbEntries)
        .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async saveEmbedding(tenantId, kbEntryId, embedding) {
      await db
        .update(kbEntries)
        .set({ embedding, embeddingStatus: null, embeddingError: null })
        .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)));
    },

    async markEmbeddingSkipped(tenantId, kbEntryId) {
      await db
        .update(kbEntries)
        .set({ embedding: null, embeddingStatus: "skipped", embeddingError: null })
        .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)));
    },

    async markEmbeddingFailed(tenantId, kbEntryId, reason) {
      await db
        .update(kbEntries)
        .set({ embeddingStatus: "failed", embeddingError: reason })
        .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)));
    },
  };
}
