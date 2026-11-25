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
import type { ApiKbQueries, ApiKbEntryRow, KbImportResult } from "../areas/api-kb.js";
import { decideKbImport } from "../shared/kb-import.js";

const ID_CHUNK = 90;

/** Re-embedding is not an edit: an entry untouched since its import stays so (G15). */
function untouchedImportedAt(now: Date): SQL {
  return sql`CASE WHEN imported_at IS NOT NULL AND imported_at >= updated_at THEN ${now.getTime()} ELSE imported_at END`;
}

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
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.externalKey !== undefined ? { externalKey: args.externalKey } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
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
              OR ${kbEntries.embeddingStatus} = 'skipped'
              OR (${kbEntries.embeddingStatus} = 'pending' AND ${kbEntries.updatedAt} < ${cutoff.getTime()})
            )`,
          ),
        );
      return rows.map((r) => r.id);
    },

    async clearEmbeddings({ tenantId }) {
      await db
        .update(kbEntries)
        .set({ embedding: null, embeddingStatus: "skipped", embeddingError: null })
        .where(eq(kbEntries.tenantId, tenantId));
    },

    async markEntriesPendingEmbedding({ tenantId, ids, now }) {
      if (ids.length === 0) return;
      const statements = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        statements.push(
          db
            .update(kbEntries)
            .set({ embeddingStatus: "pending", embeddingError: null, updatedAt: now, importedAt: untouchedImportedAt(now) })
            .where(and(eq(kbEntries.tenantId, tenantId), inArray(kbEntries.id, ids.slice(i, i + ID_CHUNK)))),
        );
      }
      await db.batch(statements as [typeof statements[number], ...typeof statements]);
    },

    async findEntryByExternalKey({ tenantId, externalKey }) {
      const rows = await db.select().from(kbEntries).where(and(eq(kbEntries.tenantId, tenantId), eq(kbEntries.externalKey, externalKey))).limit(1);
      return (rows[0] as ApiKbEntryRow | undefined) ?? null;
    },

    async importEntries({ tenantId, entries, force, dryRun, markPending, now }) {
      const existing = new Map<string, ApiKbEntryRow>();
      const keys = entries.map((e) => e.externalKey);
      for (let i = 0; i < keys.length; i += 50) {
        const rows = await db.select().from(kbEntries).where(and(eq(kbEntries.tenantId, tenantId), inArray(kbEntries.externalKey, keys.slice(i, i + 50))));
        for (const r of rows as ApiKbEntryRow[]) existing.set(r.externalKey!, r);
      }
      const result: KbImportResult = { created: 0, updated: 0, unchanged: 0, skipped_edited: 0, skipped_keys: [], contentChangedIds: [] };
      const writes: Array<(h: D1Db) => unknown> = [];
      for (const e of entries) {
        const d = decideKbImport(existing.get(e.externalKey), e, force);
        if (d.kind === "unchanged") result.unchanged++;
        else if (d.kind === "skipped_edited") {
          result.skipped_edited++;
          result.skipped_keys.push(d.key);
        } else if (d.kind === "create") {
          result.created++;
          const id = crypto.randomUUID();
          result.contentChangedIds.push(id);
          writes.push((h) =>
            h.insert(kbEntries).values({
              id, tenantId, title: e.title, content: e.content, contentType: e.contentType, source: "import", sourceUrl: e.sourceUrl,
              tags: e.tags, category: e.category, externalKey: e.externalKey, data: e.data ?? null, pinned: e.pinned, isActive: e.isActive,
              createdAt: now, updatedAt: now, importedAt: now, ...(markPending ? { embeddingStatus: "pending" } : {}),
            } as any),
          );
        } else {
          result.updated++;
          if (d.contentChanged) result.contentChangedIds.push(d.row.id);
          writes.push((h) =>
            h.update(kbEntries).set({
              title: e.title, content: e.content, contentType: e.contentType, sourceUrl: e.sourceUrl, tags: e.tags, category: e.category,
              data: e.data ?? null, pinned: e.pinned, isActive: e.isActive, updatedAt: now, importedAt: now,
              ...(markPending && d.contentChanged ? { embeddingStatus: "pending", embeddingError: null } : {}),
            } as any).where(and(eq(kbEntries.id, d.row.id), eq(kbEntries.tenantId, tenantId))),
          );
        }
      }
      if (!dryRun && writes.length > 0) {
        for (let i = 0; i < writes.length; i += 50) {
          const chunk = writes.slice(i, i + 50).map((w) => w(db));
          await db.batch(chunk as never);
        }
      }
      return result;
    },
  };
}
