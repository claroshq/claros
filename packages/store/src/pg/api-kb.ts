/**
 * Postgres implementation of the queries used by packages/api/src/routes/kb.ts.
 */
import { eq, and, sql, inArray } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiKbQueries, ApiKbEntryRow, KbImportResult } from "../areas/api-kb.js";
import { decideKbImport } from "../shared/kb-import.js";

export function pgApiKb(db: PgDb): ApiKbQueries {
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
          // Set embedding_status = 'pending' when we have an enqueue function,
          // so a crash after INSERT but before boss.send leaves a detectable orphan.
          // When enqueue is absent (tests), status stays null = "never enqueued".
          ...(args.embeddingStatus ? { embeddingStatus: args.embeddingStatus } : {}),
          isActive: args.isActive,
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.externalKey !== undefined ? { externalKey: args.externalKey } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
        } as any)
        .returning();
      return inserted;
    },

    async listEntries({ tenantId, includeInactive, cursor, limit: fetchLimit }) {
      // Build WHERE conditions. Cursor uses (created_at, id) keyset ordering:
      //   (created_at > cursor.created_at)
      //   OR (created_at = cursor.created_at AND id > cursor.id)
      // This is correct for the ORDER BY (created_at ASC, id ASC) clause below.
      const tenantCondition = eq(kbEntries.tenantId, tenantId);
      const activeCondition = eq(kbEntries.isActive, true);

      let rows: (typeof kbEntries.$inferSelect)[];

      if (cursor) {
        const cursorCreatedAt = cursor.createdAt; // ISO string (millisecond precision)
        const cursorId = cursor.id;               // UUID string

        // Cursor condition: (date_trunc('milliseconds', created_at), id) > (cursor_ts, cursor_id)
        //
        // JavaScript Date.toISOString() has millisecond precision; Postgres timestamptz
        // stores microseconds. Truncating the DB column to milliseconds before the
        // comparison ensures both sides of the ROW comparison have the same precision.
        // The ORDER BY clause below uses the same truncation expression so the ordering
        // the cursor was derived from and the cursor condition stay consistent.
        const cursorCondition = sql`
          ROW(date_trunc('milliseconds', ${kbEntries.createdAt}), ${kbEntries.id}) >
          ROW(${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        `;

        rows = includeInactive
          ? await db
              .select()
              .from(kbEntries)
              .where(and(tenantCondition, cursorCondition))
              .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
              .limit(fetchLimit)
          : await db
              .select()
              .from(kbEntries)
              .where(and(tenantCondition, activeCondition, cursorCondition))
              .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
              .limit(fetchLimit);
      } else {
        rows = includeInactive
          ? await db
              .select()
              .from(kbEntries)
              .where(tenantCondition)
              .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
              .limit(fetchLimit)
          : await db
              .select()
              .from(kbEntries)
              .where(and(tenantCondition, activeCondition))
              .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
              .limit(fetchLimit);
      }
      return rows;
    },

    async findEntry({ tenantId, id }) {
      const rows = await db
        .select()
        .from(kbEntries)
        .where(
          and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateEntry({ tenantId, id, patch }) {
      const [updated] = await db
        .update(kbEntries)
        .set(patch as any)
        .where(
          and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
        )
        .returning();
      return updated;
    },

    async deleteEntry({ tenantId, id }) {
      await db
        .delete(kbEntries)
        .where(
          and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
        );
    },

    async listReEmbedCandidateIds({ tenantId, orphanThresholdMinutes }) {
      const orphanThreshold = `now() - interval '${orphanThresholdMinutes} minutes'`;

      const allQualifying = await db
        .select({ id: kbEntries.id })
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            sql`${kbEntries.embedding} IS NULL`,
            sql`(
              ${kbEntries.embeddingStatus as any} IS NULL
              OR ${kbEntries.embeddingStatus as any} = 'failed'
              OR ${kbEntries.embeddingStatus as any} = 'skipped'
              OR (${kbEntries.embeddingStatus as any} = 'pending'
                  AND ${kbEntries.updatedAt} < ${sql.raw(orphanThreshold)})
            )`,
          ),
        );
      return allQualifying.map((r) => r.id);
    },

    async clearEmbeddings({ tenantId }) {
      await db
        .update(kbEntries)
        .set({ embedding: null, embeddingStatus: "skipped", embeddingError: null })
        .where(eq(kbEntries.tenantId, tenantId));
    },

    async markEntriesPendingEmbedding({ tenantId, ids, now }) {
      await db
        .update(kbEntries)
        .set({
          embeddingStatus: "pending",
          embeddingError: null,
          updatedAt: now,
          // Re-embedding is not an edit: an entry untouched since its import stays so (G15).
          importedAt: sql`CASE WHEN imported_at IS NOT NULL AND imported_at >= updated_at THEN ${now} ELSE imported_at END`,
        } as any)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            sql`id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`,
          ),
        );
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
      const writes: Array<(h: PgDb) => unknown> = [];
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
        await db.transaction(async (tx) => {
          for (const w of writes) await w(tx as unknown as PgDb);
        });
      }
      return result;
    },
  };
}
