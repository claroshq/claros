/**
 * Postgres implementation of the queries in ../areas/api-topics.ts.
 */
import { and, asc, eq } from "drizzle-orm";
import { topics } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiTopicsQueries } from "../areas/api-topics.js";

const TOPIC_COLUMNS = {
  id: topics.id,
  tenantId: topics.tenantId,
  slug: topics.slug,
  name: topics.name,
  kind: topics.kind,
  description: topics.description,
  defaultSubscribed: topics.defaultSubscribed,
  mirrorOnly: topics.mirrorOnly,
  createdAt: topics.createdAt,
} as const;

export function pgApiTopics(db: PgDb): ApiTopicsQueries {
  return {
    async listTopics(tenantId) {
      return db
        .select(TOPIC_COLUMNS)
        .from(topics)
        .where(eq(topics.tenantId, tenantId))
        .orderBy(asc(topics.createdAt), asc(topics.slug));
    },

    async findTopic({ tenantId, id }) {
      const rows = await db
        .select(TOPIC_COLUMNS)
        .from(topics)
        .where(and(eq(topics.tenantId, tenantId), eq(topics.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    async createTopic(input) {
      // The unique index (tenant_id, slug) decides a concurrent duplicate.
      const rows = await db
        .insert(topics)
        .values({
          tenantId: input.tenantId,
          slug: input.slug,
          name: input.name,
          kind: input.kind,
          description: input.description,
          defaultSubscribed: input.defaultSubscribed,
          mirrorOnly: input.mirrorOnly ?? false,
        })
        .onConflictDoNothing()
        .returning(TOPIC_COLUMNS);
      return rows[0] ?? null;
    },

    async updateTopic({ tenantId, id, patch }) {
      const set: Partial<typeof topics.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.defaultSubscribed !== undefined) set.defaultSubscribed = patch.defaultSubscribed;
      if (patch.mirrorOnly !== undefined) set.mirrorOnly = patch.mirrorOnly;
      if (Object.keys(set).length === 0) {
        const rows = await db
          .select(TOPIC_COLUMNS)
          .from(topics)
          .where(and(eq(topics.tenantId, tenantId), eq(topics.id, id)))
          .limit(1);
        return rows[0] ?? null;
      }
      const rows = await db
        .update(topics)
        .set(set)
        .where(and(eq(topics.tenantId, tenantId), eq(topics.id, id)))
        .returning(TOPIC_COLUMNS);
      return rows[0] ?? null;
    },
  };
}
