/**
 * Postgres implementation of the queries used by packages/worker/src/embed-kb.ts.
 */
import { eq, and } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerEmbedKbQueries } from "../areas/worker-embed-kb.js";

export function pgWorkerEmbedKb(db: PgDb): WorkerEmbedKbQueries {
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
        .set({
          embedding: embedding,
          embeddingStatus: null,
          embeddingError: null,
        } as any)
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
        .set({
          embeddingStatus: "failed",
          embeddingError: reason,
        } as any)
        .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)));
    },
  };
}
