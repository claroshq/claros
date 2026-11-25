/**
 * Contact topic statuses on Postgres (shared by the apiContacts, apiIngest and
 * apiUnsubscribe areas).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { contactTopics, topics } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ContactTopicStatusRow } from "../areas/shared-topics.js";

/** Every topic of the tenant with the contact's explicit status (null = default). */
export async function listContactTopicStatuses(
  db: PgDb,
  tenantId: string,
  contactId: string,
): Promise<ContactTopicStatusRow[]> {
  const rows = await db
    .select({
      topicId: topics.id,
      slug: topics.slug,
      name: topics.name,
      kind: topics.kind,
      defaultSubscribed: topics.defaultSubscribed,
      status: contactTopics.status,
      source: contactTopics.source,
      updatedAt: contactTopics.updatedAt,
    })
    .from(topics)
    .leftJoin(contactTopics, and(eq(contactTopics.topicId, topics.id), eq(contactTopics.contactId, contactId)))
    .where(eq(topics.tenantId, tenantId))
    .orderBy(asc(topics.createdAt), asc(topics.slug));
  return rows.map((r) => ({ ...r, status: r.status ?? null, source: r.source ?? null, updatedAt: r.updatedAt ?? null }));
}

/**
 * One upsert of a contact's status for one topic. Topic and contact must both
 * belong to the tenant (the SELECT yields no row otherwise, nothing is written).
 */
export function upsertContactTopicSql(input: {
  tenantId: string;
  topicCondition: ReturnType<typeof sql>;
  contactCondition: ReturnType<typeof sql>;
  status: string;
  source: string;
  now: Date;
}) {
  return sql`
    INSERT INTO contact_topics (tenant_id, contact_id, topic_id, status, updated_at, source)
    SELECT t.tenant_id, c.id, t.id, ${input.status}, ${input.now}, ${input.source}
    FROM topics t
    JOIN contacts c ON c.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${input.tenantId}::uuid
      AND ${input.topicCondition}
      AND ${input.contactCondition}
    ON CONFLICT (contact_id, topic_id) DO UPDATE
      SET status = excluded.status, updated_at = excluded.updated_at, source = excluded.source
  `;
}

/** Set several statuses for one contact (by id) in one transaction. */
export async function setContactTopicStatuses(
  db: PgDb,
  input: {
    tenantId: string;
    contactId: string;
    statuses: Array<{ topicId: string; status: "subscribed" | "unsubscribed" }>;
    source: string;
    now: Date;
  },
): Promise<void> {
  if (input.statuses.length === 0) return;
  await db.transaction(async (tx) => {
    for (const s of input.statuses) {
      await tx.execute(
        upsertContactTopicSql({
          tenantId: input.tenantId,
          topicCondition: sql`t.id = ${s.topicId}::uuid`,
          contactCondition: sql`c.id = ${input.contactId}::uuid`,
          status: s.status,
          source: input.source,
          now: input.now,
        }),
      );
    }
  });
}
