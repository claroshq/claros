/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-kb.ts.
 *
 * - listEntries: created_at is stored as integer milliseconds, so the
 *   Postgres date_trunc('milliseconds', ...) is the column itself; the keyset
 *   cursor is a row-value comparison (created_at, id) > (cursor ms, cursor id).
 * - listReEmbedCandidateIds: the orphan cutoff (now() - interval) is computed
 *   in JS and bound.
 * - markEntriesPendingEmbedding: = ANY(array) becomes IN (...), chunked to stay
 *   under D1's bound-parameter limit and run as one batch (all or nothing).
 */
import { eq, and, sql, inArray, type SQL } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiKbQueries } from "../areas/api-kb.js";

const ID_CHUNK = 90;

export function d1ApiKb(db: D1Db): ApiKbQueries {
  return {
    async createEntry(args) {
      const [inserted] = await db
        .insert(kbEntries)
        .values({
          tenantId: args.tenantId,
          title: args.title,
          content: args.content,
          contentType: args.contentType,
          source: args.source,
          sourceUrl: args.sourceUrl,
          tags: args.tags,
          ...(args.embeddingStatus ? { embeddingStatus: args.embeddingStatus } : {}),
          isActive: args.isActive,
        })
        .returning();
      return inserted;
    },

    async listEntries({ tenantId, includeInactive, cursor, limit }) {
      const conditions: SQL[] = [eq(kbEntries.tenantId, tenantId)];
      if (!includeInactive) conditions.push(eq(kbEntries.isActive, true));
      if (cursor) {
        const cursorMs = new Date(cursor.createdAt).getTime();
        conditions.push(sql`(${kbEntries.createdAt}, ${kbEntries.id}) > (${cursorMs}, ${cursor.id})`);
      }
      return db
        .select()
        .from(kbEntries)
        .where(and(...conditions))
        // Postgres sorts NULL created_at last in ASC order; SQLite sorts it first.
        .orderBy(sql`${kbEntries.createdAt} IS NULL`, kbEntries.createdAt, kbEntries.id)
        .limit(limit);
    },

    async findEntry({ tenantId, id }) {
      const rows = await db
        .select()
        .from(kbEntries)
        .where(and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateEntry({ tenantId, id, patch }) {
      const [updated] = await db
        .update(kbEntries)
        .set(patch as any)
        .where(and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)))
        .returning();
      return updated;
    },

    async deleteEntry({ tenantId, id }) {
      await db
        .delete(kbEntries)
        .where(and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)));
    },

    async listReEmbedCandidateIds({ tenantId, orphanThresholdMinutes }) {
      const cutoff = new Date(Date.now() - orphanThresholdMinutes * 60_000);
      const rows = await db
        .select({ id: kbEntries.id })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            sql`${kbEntries.embedding} IS NULL`,
            sql`(
              ${kbEntries.embeddingStatus} IS NULL
              OR ${kbEntries.embeddingStatus} = 'failed'
              OR (${kbEntries.embeddingStatus} = 'pending' AND ${kbEntries.updatedAt} < ${cutoff.getTime()})
            )`,
          ),
        );
      return rows.map((r) => r.id);
    },

    async markEntriesPendingEmbedding({ tenantId, ids, now }) {
      if (ids.length === 0) return;
      const statements = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        statements.push(
          db
            .update(kbEntries)
            .set({ embeddingStatus: "pending", embeddingError: null, updatedAt: now })
            .where(and(eq(kbEntries.tenantId, tenantId), inArray(kbEntries.id, ids.slice(i, i + ID_CHUNK)))),
        );
      }
      await db.batch(statements as [typeof statements[number], ...typeof statements]);
    },
  };
}
