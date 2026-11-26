/**
 * SQLite / D1 implementation of ../areas/api-import.ts.
 *
 * Messages: each item is one batch: the membership insert is guarded by the
 * import key being free, and the message insert (ON CONFLICT DO NOTHING on
 * uq_messages_import_key) only runs when the membership insert changed a row.
 *
 * Events: contacts are created first (ON CONFLICT DO NOTHING on the external
 * id), then events in batches, each insert guarded by "no event with this
 * message_id" (live ingest uses the same guard, so the two cannot both store
 * one messageId).
 *
 * Lifecycle replay: per contact, one group of statements in a batch: the
 * import transitions are replaced and the contact updated, every statement
 * guarded by the expected state and last_seen_at (the UPDATE last, so the
 * guards before it see the pre-update row).
 */
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { contacts, events, flows, kbEntries, lifecycleMessages } from "@claros/db/schema-sqlite";
import type { LifecycleState } from "@claros/core";
import type { D1Db } from "./db.js";
import { rawBatch } from "./raw-batch.js";
import type { ApiImportQueries, EventImportResult, HistoryImportResult, LifecycleReplayContact } from "../areas/api-import.js";

/** Statements per D1 batch. */
const BATCH = 50;

export function d1ApiImport(db: D1Db): ApiImportQueries {
  return {
    async importMessages({ tenantId, items, dryRun }) {
      const result: HistoryImportResult = { imported: 0, duplicates: 0, errors: [] };
      if (items.length === 0) return result;
      const keys = [...new Set(items.map((i) => i.importKey))];
      const existing = new Set<string>();
      for (let i = 0; i < keys.length; i += 90) {
        const rows = await db
          .select({ k: lifecycleMessages.importKey })
          .from(lifecycleMessages)
          .where(and(eq(lifecycleMessages.tenantId, tenantId), inArray(lifecycleMessages.importKey, keys.slice(i, i + 90))));
        for (const r of rows) if (r.k) existing.add(r.k);
      }
      const slugs = [...new Set(items.map((i) => i.flowSlug))];
      const flowBySlug = new Map<string, { id: string; topicId: string | null }>();
      for (let i = 0; i < slugs.length; i += 90) {
        const rows = await db.select({ id: flows.id, slug: flows.slug, topicId: flows.topicId }).from(flows).where(and(eq(flows.tenantId, tenantId), inArray(flows.slug, slugs.slice(i, i + 90))));
        for (const f of rows) flowBySlug.set(f.slug!, f);
      }
      const kbKeys = [...new Set(items.map((i) => i.kbExternalKey).filter((k): k is string => !!k))];
      const kbByKey = new Map<string, string>();
      for (let i = 0; i < kbKeys.length; i += 90) {
        const rows = await db.select({ id: kbEntries.id, k: kbEntries.externalKey }).from(kbEntries).where(and(eq(kbEntries.tenantId, tenantId), inArray(kbEntries.externalKey, kbKeys.slice(i, i + 90))));
        for (const r of rows) kbByKey.set(r.k!, r.id);
      }
      const seen = new Set<string>();
      for (const item of items) {
        if (existing.has(item.importKey) || seen.has(item.importKey)) {
          result.duplicates++;
          continue;
        }
        const flow = flowBySlug.get(item.flowSlug);
        if (!flow) {
          result.errors.push({ index: item.index, error: `unknown flow '${item.flowSlug}'` });
          continue;
        }
        let contact: { id: string; email: string | null } | undefined;
        if (item.externalId) {
          contact = (await db.select({ id: contacts.id, email: contacts.email }).from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, item.externalId))).limit(1))[0];
        }
        if (!contact && item.email) {
          contact = (await db.select({ id: contacts.id, email: contacts.email }).from(contacts).where(and(eq(contacts.tenantId, tenantId), sql`lower(${contacts.email}) = ${item.email.toLowerCase()}`)).limit(1))[0];
        }
        if (!contact) {
          result.errors.push({ index: item.index, error: "contact not found (by external_id or email)" });
          continue;
        }
        let kbEntryId: string | null = null;
        if (item.kbExternalKey) {
          kbEntryId = kbByKey.get(item.kbExternalKey) ?? null;
          if (!kbEntryId) {
            result.errors.push({ index: item.index, error: `unknown kb_external_key '${item.kbExternalKey}'` });
            continue;
          }
        }
        seen.add(item.importKey);
        if (dryRun) {
          result.imported++;
          continue;
        }
        const membershipId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const at = item.sentAt.getTime();
        const res = await rawBatch(db, [
          sql`INSERT INTO flow_memberships (id, tenant_id, contact_id, flow_id, current_step, status, entered_at, completed_at, exit_reason)
              SELECT ${membershipId}, ${tenantId}, ${contact.id}, ${flow.id}, ${item.stepOrder}, 'completed', ${at}, ${at}, 'imported'
              WHERE NOT EXISTS (SELECT 1 FROM lifecycle_messages WHERE tenant_id = ${tenantId} AND import_key = ${item.importKey})
              RETURNING id`,
          sql`INSERT INTO lifecycle_messages (id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, subject,
                brain_action_type, sent_at, recipient_address, topic_id, kb_entry_id, imported, import_key, status_reason, retry_count, created_at, updated_at)
              SELECT ${messageId}, ${tenantId}, ${contact.id}, ${flow.id}, ${membershipId}, ${item.stepOrder}, 'sent', ${item.subject},
                ${item.actionType}, ${at}, ${contact.email}, ${flow.topicId}, ${kbEntryId}, 1, ${item.importKey}, 'imported', 0, ${at}, ${at}
              WHERE changes() > 0
              ON CONFLICT DO NOTHING
              RETURNING id`,
        ]);
        if ((res[1] ?? []).length > 0) result.imported++;
        else result.duplicates++;
      }
      return result;
    },

    async importEvents({ tenantId, items, dryRun, now }) {
      const result: EventImportResult = { imported: 0, duplicates: 0, contactsCreated: 0, errors: [] };
      if (items.length === 0) return result;
      const nowMs = now.getTime();

      const existing = new Set<string>();
      const ids = [...new Set(items.map((i) => i.messageId))];
      for (let i = 0; i < ids.length; i += 90) {
        const rows = await db
          .select({ m: events.messageId })
          .from(events)
          .where(and(eq(events.tenantId, tenantId), inArray(events.messageId, ids.slice(i, i + 90))));
        for (const r of rows) if (r.m) existing.add(r.m);
      }

      const byExt = new Map<string, string>();
      const extIds = [...new Set(items.map((i) => i.externalId).filter((x): x is string => !!x))];
      for (let i = 0; i < extIds.length; i += 90) {
        const rows = await db
          .select({ id: contacts.id, ext: contacts.externalId })
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.externalId, extIds.slice(i, i + 90))));
        for (const r of rows) byExt.set(r.ext, r.id);
      }
      const byEmail = new Map<string, string | null>();
      const emailContact = async (email: string) => {
        const key = email.toLowerCase();
        if (!byEmail.has(key)) {
          const row = (await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.tenantId, tenantId), sql`lower(${contacts.email}) = ${key}`)).limit(1))[0];
          byEmail.set(key, row?.id ?? null);
        }
        return byEmail.get(key) ?? null;
      };

      const toCreate = new Map<string, number>();
      const planned: Array<{ item: (typeof items)[number]; contactId: string | null }> = [];
      const seen = new Set<string>();
      for (const item of items) {
        if (existing.has(item.messageId) || seen.has(item.messageId)) {
          result.duplicates++;
          continue;
        }
        let contactId = item.externalId ? byExt.get(item.externalId) ?? null : null;
        if (!contactId && item.email) contactId = await emailContact(item.email);
        if (!contactId) {
          if (!item.externalId) {
            result.errors.push({ index: item.index, error: "contact not found by email (give external_id to create it)" });
            continue;
          }
          const t = item.timestamp.getTime();
          toCreate.set(item.externalId, Math.min(toCreate.get(item.externalId) ?? t, t));
        }
        seen.add(item.messageId);
        planned.push({ item, contactId });
      }
      if (dryRun) {
        result.imported = planned.length;
        result.contactsCreated = toCreate.size;
        return result;
      }

      const creates = [...toCreate.entries()];
      for (let i = 0; i < creates.length; i += BATCH) {
        const res = await rawBatch(
          db,
          creates.slice(i, i + BATCH).map(
            ([ext, t]) => sql`
              INSERT INTO contacts (id, tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at, event_count_bucket_current, created_at)
              VALUES (${crypto.randomUUID()}, ${tenantId}, ${ext}, 'signed_up', ${t}, ${t}, 0, ${nowMs})
              ON CONFLICT (tenant_id, external_id) DO NOTHING
              RETURNING id`,
          ),
        );
        result.contactsCreated += res.filter((r) => r.length > 0).length;
      }
      const createdExt = creates.map(([ext]) => ext);
      for (let i = 0; i < createdExt.length; i += 90) {
        const rows = await db
          .select({ id: contacts.id, ext: contacts.externalId })
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.externalId, createdExt.slice(i, i + 90))));
        for (const r of rows) byExt.set(r.ext, r.id);
      }

      const context = JSON.stringify({ source: "import" });
      for (let i = 0; i < planned.length; i += BATCH) {
        const res = await rawBatch(
          db,
          planned.slice(i, i + BATCH).map(({ item, contactId }) => {
            const cid = contactId ?? byExt.get(item.externalId!)!;
            return sql`
              INSERT INTO events (id, tenant_id, contact_id, type, event_name, properties, context, message_id, timestamp, received_at)
              SELECT ${crypto.randomUUID()}, ${tenantId}, ${cid}, 'track', ${item.eventName},
                ${item.properties ? JSON.stringify(item.properties) : null}, ${context}, ${item.messageId},
                ${item.timestamp.getTime()}, ${nowMs}
              WHERE NOT EXISTS (SELECT 1 FROM events WHERE tenant_id = ${tenantId} AND message_id = ${item.messageId})
              RETURNING id`;
          }),
        );
        for (const r of res) {
          if (r.length > 0) result.imported++;
          else result.duplicates++;
        }
      }
      return result;
    },

    async listLifecycleReplayPage({ tenantId, afterContactId, limit }) {
      const where = afterContactId
        ? and(eq(contacts.tenantId, tenantId), gt(contacts.id, afterContactId))
        : eq(contacts.tenantId, tenantId);
      const rows = await db
        .select({
          id: contacts.id,
          lifecycleState: contacts.lifecycleState,
          firstSeenAt: contacts.firstSeenAt,
          lastSeenAt: contacts.lastSeenAt,
          activatedAt: contacts.activatedAt,
          lastCounterResetAt: contacts.lastCounterResetAt,
          eventCountBucketCurrent: contacts.eventCountBucketCurrent,
          eventCountBucketPrev: contacts.eventCountBucketPrev,
          engagementDepth: contacts.engagementDepth,
        })
        .from(contacts)
        .where(where)
        .orderBy(asc(contacts.id))
        .limit(limit);
      if (rows.length === 0) return [];
      const page = new Map<string, LifecycleReplayContact>(
        rows.map((r) => [
          r.id,
          {
            ...r,
            lifecycleState: r.lifecycleState as LifecycleState,
            eventCountBucketCurrent: r.eventCountBucketCurrent ?? 0,
            eventCountBucketPrev: r.eventCountBucketPrev ?? 0,
            events: [],
          },
        ]),
      );
      const last = rows[rows.length - 1]!.id;
      const first = rows[0]!.id;
      const evs = await db.all<{ contact_id: string; type: string; event_name: string | null; timestamp: number }>(sql`
        SELECT contact_id, type, event_name, timestamp FROM events
        WHERE tenant_id = ${tenantId}
          AND contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${tenantId} AND id >= ${first} AND id <= ${last})
        ORDER BY contact_id, timestamp`);
      for (const e of evs) {
        page.get(e.contact_id)?.events.push({
          type: e.type === "identify" ? "identify" : "track",
          eventName: e.event_name,
          timestamp: new Date(Number(e.timestamp)),
        });
      }
      return [...page.values()];
    },

    async applyLifecycleReplay({ tenantId, updates }) {
      let applied = 0;
      const statementsPer = 3;
      const perBatch = Math.max(1, Math.floor(BATCH / statementsPer));
      for (let i = 0; i < updates.length; i += perBatch) {
        const queries: SQL[] = [];
        for (const u of updates.slice(i, i + perBatch)) {
          const expectedLast = u.expected.lastSeenAt ? u.expected.lastSeenAt.getTime() : null;
          const guard = sql`EXISTS (SELECT 1 FROM contacts WHERE tenant_id = ${tenantId} AND id = ${u.contactId}
            AND lifecycle_state = ${u.expected.state} AND last_seen_at IS ${expectedLast})`;
          const rows = JSON.stringify(
            u.transitions.map((t) => ({ id: crypto.randomUUID(), from: t.from, to: t.to, at: t.at.getTime(), meta: JSON.stringify({ source: "import", trigger: t.trigger }) })),
          );
          queries.push(sql`
            DELETE FROM lifecycle_transitions
            WHERE tenant_id = ${tenantId} AND contact_id = ${u.contactId}
              AND json_extract(metadata, '$.source') = 'import' AND ${guard}`);
          queries.push(sql`
            INSERT INTO lifecycle_transitions (id, tenant_id, contact_id, from_state, to_state, trigger_event_id, metadata, transitioned_at)
            SELECT json_extract(value, '$.id'), ${tenantId}, ${u.contactId}, json_extract(value, '$.from'), json_extract(value, '$.to'),
              NULL, json_extract(value, '$.meta'), json_extract(value, '$.at')
            FROM json_each(${rows})
            WHERE ${guard}`);
          queries.push(sql`
            UPDATE contacts SET
              lifecycle_state = ${u.state},
              first_seen_at = ${u.firstSeenAt.getTime()},
              last_seen_at = ${u.lastSeenAt.getTime()},
              activated_at = ${u.activatedAt ? u.activatedAt.getTime() : null},
              event_count_bucket_current = ${u.counters.current},
              event_count_bucket_prev = ${u.counters.prev},
              last_counter_reset_at = ${u.counters.resetAt.getTime()}
            WHERE tenant_id = ${tenantId} AND id = ${u.contactId}
              AND lifecycle_state = ${u.expected.state} AND last_seen_at IS ${expectedLast}
            RETURNING id`);
        }
        const res = await rawBatch(db, queries);
        for (let k = statementsPer - 1; k < res.length; k += statementsPer) if (res[k]!.length > 0) applied++;
      }
      return { applied, skipped: updates.length - applied };
    },

    async listSegmentFlows(tenantId) {
      return db
        .select({ slug: flows.slug, name: flows.name, status: flows.status, triggerConfig: flows.triggerConfig })
        .from(flows)
        .where(and(eq(flows.tenantId, tenantId), eq(flows.triggerType, "segment")))
        .then((rows) => rows.map((r) => ({ ...r, status: r.status ?? "draft" })));
    },
  };
}
