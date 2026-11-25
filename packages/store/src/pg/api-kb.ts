/**
 * Postgres implementation of the queries used by packages/api/src/routes/kb.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiKbQueries } from "../areas/api-kb.js";

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
              OR (${kbEntries.embeddingStatus as any} = 'pending'
                  AND ${kbEntries.updatedAt} < ${sql.raw(orphanThreshold)})
            )`,
          ),
        );
      return allQualifying.map((r) => r.id);
    },

    async markEntriesPendingEmbedding({ tenantId, ids, now }) {
      await db
        .update(kbEntries)
        .set({
          embeddingStatus: "pending",
          embeddingError: null,
          updatedAt: now,
        } as any)
        .where(
          and(
            eq(kbEntries.tenantId, tenantId),
            sql`id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`,
          ),
        );
    },
  };
}
