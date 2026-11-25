/**
 * Contact topic statuses on SQLite / D1 (shared by the apiContacts, apiIngest
 * and apiUnsubscribe areas). Multi-row writes are one raw batch (atomic).
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { contactTopics, topics } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { rawBatch } from "./raw-batch.js";
import type { ContactTopicStatusRow } from "../areas/shared-topics.js";

/** Every topic of the tenant with the contact's explicit status (null = default). */
export async function listContactTopicStatuses(
  db: D1Db,
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

/** One upsert; topic and contact must both belong to the tenant, else nothing is written. */
export function upsertContactTopicSql(input: {
  tenantId: string;
  topicCondition: SQL;
  contactCondition: SQL;
  status: string;
  source: string;
  now: Date;
}): SQL {
  return sql`
    INSERT INTO contact_topics (tenant_id, contact_id, topic_id, status, updated_at, source)
    SELECT t.tenant_id, c.id, t.id, ${input.status}, ${input.now.getTime()}, ${input.source}
    FROM topics t
    JOIN contacts c ON c.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${input.tenantId}
      AND ${input.topicCondition}
      AND ${input.contactCondition}
    ON CONFLICT (contact_id, topic_id) DO UPDATE
      SET status = excluded.status, updated_at = excluded.updated_at, source = excluded.source
  `;
}

/** Set several statuses for one contact (by id) in one batch. */
export async function setContactTopicStatuses(
  db: D1Db,
  input: {
    tenantId: string;
    contactId: string;
    statuses: Array<{ topicId: string; status: "subscribed" | "unsubscribed" }>;
    source: string;
    now: Date;
  },
): Promise<void> {
  if (input.statuses.length === 0) return;
  await rawBatch(
    db,
    input.statuses.map((s) =>
      upsertContactTopicSql({
        tenantId: input.tenantId,
        topicCondition: sql`t.id = ${s.topicId}`,
        contactCondition: sql`c.id = ${input.contactId}`,
        status: s.status,
        source: input.source,
        now: input.now,
      }),
    ),
  );
}
