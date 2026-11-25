/**
 * Queries used by packages/api/src/routes/topics.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-topics.ts (Postgres) and
 * ../d1/api-topics.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A topics row. */
export interface TopicRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  /** marketing | lifecycle | transactional */
  kind: string;
  description: string | null;
  defaultSubscribed: boolean;
  /** P5b: consent mirror only; no flow may send on it. */
  mirrorOnly: boolean;
  createdAt: Date | null;
}

export interface NewTopic {
  tenantId: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  defaultSubscribed: boolean;
  mirrorOnly?: boolean;
}

/** Fields a PATCH may set; absent keys are left unchanged. The slug is fixed. */
export interface TopicPatch {
  name?: string;
  kind?: string;
  description?: string | null;
  defaultSubscribed?: boolean;
  mirrorOnly?: boolean;
}

export interface ApiTopicsQueries {
  /** The tenant's topics, oldest first (created_at, then slug). */
  listTopics(tenantId: string): Promise<TopicRow[]>;
  /** The tenant's topic by id, or null. */
  findTopic(input: { tenantId: string; id: string }): Promise<TopicRow | null>;
  /** Insert a topic; null when the tenant already has a topic with this slug (nothing written). */
  createTopic(input: NewTopic): Promise<TopicRow | null>;
  /** Apply a partial update to the tenant's topic; null when it does not exist. */
  updateTopic(input: { tenantId: string; id: string; patch: TopicPatch }): Promise<TopicRow | null>;
}
