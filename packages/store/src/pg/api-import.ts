/**
 * Postgres implementation of ../areas/api-import.ts.
 *
 * Events: each chunk is one transaction; every item takes the same
 * transaction-scoped advisory lock on (tenant, messageId) as live ingest
 * before checking the messageId, so an import and a live event with the same
 * messageId store it once.
 *
 * Lifecycle replay: one transaction per contact; the compare-and-set UPDATE
 * runs first (and locks the row), the import transitions are replaced only
 * when it applied.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { contacts, events, flows, flowMemberships, kbEntries, lifecycleMessages, lifecycleTransitions } from "@claros/db/schema";
import { dedupLockKey, type LifecycleState } from "@claros/core";
import type { PgDb } from "./db.js";
import type { ApiImportQueries, EventImportResult, HistoryImportResult, LifecycleReplayContact } from "../areas/api-import.js";

/** Items per event-import transaction. */
const EVENT_TX = 100;

export function pgApiImport(db: PgDb): ApiImportQueries {
  return {
    async importMessages({ tenantId, items, dryRun }) {
      const result: HistoryImportResult = { imported: 0, duplicates: 0, errors: [] };
      if (items.length === 0) return result;
      const keys = [...new Set(items.map((i) => i.importKey))];
      const existing = new Set<string>();
      for (let i = 0; i < keys.length; i += 500) {
        const rows = await db
          .select({ k: lifecycleMessages.importKey })
          .from(lifecycleMessages)
          .where(and(eq(lifecycleMessages.tenantId, tenantId), inArray(lifecycleMessages.importKey, keys.slice(i, i + 500))));
        for (const r of rows) if (r.k) existing.add(r.k);
      }
      const flowRows = await db
        .select({ id: flows.id, slug: flows.slug, topicId: flows.topicId })
        .from(flows)
        .where(and(eq(flows.tenantId, tenantId), inArray(flows.slug, [...new Set(items.map((i) => i.flowSlug))])));
      const flowBySlug = new Map(flowRows.map((f) => [f.slug!, f]));
      const kbKeys = [...new Set(items.map((i) => i.kbExternalKey).filter((k): k is string => !!k))];
      const kbByKey = new Map<string, string>();
      if (kbKeys.length > 0) {
        const rows = await db.select({ id: kbEntries.id, k: kbEntries.externalKey }).from(kbEntries).where(and(eq(kbEntries.tenantId, tenantId), inArray(kbEntries.externalKey, kbKeys)));
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
        const wrote = await db.transaction(async (txh) => {
          const tx = txh as unknown as PgDb;
          const [m] = await tx
            .insert(flowMemberships)
            .values({
              tenantId,
              contactId: contact!.id,
              flowId: flow.id,
              currentStep: item.stepOrder,
              status: "completed",
              enteredAt: item.sentAt,
              completedAt: item.sentAt,
              exitReason: "imported",
            })
            .returning({ id: flowMemberships.id });
          const inserted = await tx
            .insert(lifecycleMessages)
            .values({
              tenantId,
              contactId: contact!.id,
              flowId: flow.id,
              membershipId: m!.id,
              flowStepOrder: item.stepOrder,
              status: "sent",
              subject: item.subject,
              brainActionType: item.actionType,
              sentAt: item.sentAt,
              recipientAddress: contact!.email,
              topicId: flow.topicId,
              kbEntryId,
              imported: true,
              importKey: item.importKey,
              statusReason: "imported",
              createdAt: item.sentAt,
              updatedAt: item.sentAt,
            })
            .onConflictDoNothing()
            .returning({ id: lifecycleMessages.id });
          if (inserted.length === 0) throw new DuplicateImport();
          return true;
        }).catch((err) => {
          if (err instanceof DuplicateImport) return false;
          throw err;
        });
        if (wrote) result.imported++;
        else result.duplicates++;
      }
      return result;
    },

    async importEvents({ tenantId, items, dryRun, now }) {
      const result: EventImportResult = { imported: 0, duplicates: 0, contactsCreated: 0, errors: [] };
      if (items.length === 0) return result;

      const existing = new Set<string>();
      const ids = [...new Set(items.map((i) => i.messageId))];
      for (let i = 0; i < ids.length; i += 500) {
        const rows = await db
          .select({ m: events.messageId })
          .from(events)
          .where(and(eq(events.tenantId, tenantId), inArray(events.messageId, ids.slice(i, i + 500))));
        for (const r of rows) if (r.m) existing.add(r.m);
      }

      const byExt = new Map<string, string>();
      const extIds = [...new Set(items.map((i) => i.externalId).filter((x): x is string => !!x))];
      for (let i = 0; i < extIds.length; i += 500) {
        const rows = await db
          .select({ id: contacts.id, ext: contacts.externalId })
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.externalId, extIds.slice(i, i + 500))));
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

      const toCreate = new Map<string, Date>();
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
          const prev = toCreate.get(item.externalId);
          if (!prev || item.timestamp < prev) toCreate.set(item.externalId, item.timestamp);
        }
        seen.add(item.messageId);
        planned.push({ item, contactId });
      }
      if (dryRun) {
        result.imported = planned.length;
        result.contactsCreated = toCreate.size;
        return result;
      }

      for (const [ext, at] of toCreate) {
        const created = await db
          .insert(contacts)
          .values({ tenantId, externalId: ext, lifecycleState: "signed_up", firstSeenAt: at, lastSeenAt: at, eventCountBucketCurrent: 0, createdAt: now })
          .onConflictDoNothing()
          .returning({ id: contacts.id });
        if (created.length > 0) result.contactsCreated++;
      }
      const createdExt = [...toCreate.keys()];
      for (let i = 0; i < createdExt.length; i += 500) {
        const rows = await db
          .select({ id: contacts.id, ext: contacts.externalId })
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.externalId, createdExt.slice(i, i + 500))));
        for (const r of rows) byExt.set(r.ext, r.id);
      }

      for (let i = 0; i < planned.length; i += EVENT_TX) {
        const chunk = planned.slice(i, i + EVENT_TX);
        const wrote = await db.transaction(async (txh) => {
          const tx = txh as unknown as PgDb;
          let n = 0;
          for (const { item, contactId } of chunk) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${dedupLockKey(tenantId, item.messageId)})`);
            const dup = await tx.execute(sql`SELECT 1 FROM events WHERE tenant_id = ${tenantId} AND message_id = ${item.messageId} LIMIT 1`);
            if (dup.rows.length > 0) continue;
            await tx.insert(events).values({
              tenantId,
              contactId: contactId ?? byExt.get(item.externalId!)!,
              type: "track",
              eventName: item.eventName,
              properties: item.properties,
              context: { source: "import" },
              messageId: item.messageId,
              timestamp: item.timestamp,
              receivedAt: now,
            });
            n++;
          }
          return n;
        });
        result.imported += wrote;
        result.duplicates += chunk.length - wrote;
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
      const evs = await db
        .select({ contactId: events.contactId, type: events.type, eventName: events.eventName, timestamp: events.timestamp })
        .from(events)
        .where(and(eq(events.tenantId, tenantId), inArray(events.contactId, rows.map((r) => r.id))))
        .orderBy(asc(events.contactId), asc(events.timestamp));
      for (const e of evs) {
        page.get(e.contactId)?.events.push({ type: e.type === "identify" ? "identify" : "track", eventName: e.eventName, timestamp: e.timestamp });
      }
      return [...page.values()];
    },

    async applyLifecycleReplay({ tenantId, updates }) {
      let applied = 0;
      for (const u of updates) {
        const ok = await db.transaction(async (txh) => {
          const tx = txh as unknown as PgDb;
          const updated = await tx
            .update(contacts)
            .set({
              lifecycleState: u.state,
              firstSeenAt: u.firstSeenAt,
              lastSeenAt: u.lastSeenAt,
              activatedAt: u.activatedAt,
              eventCountBucketCurrent: u.counters.current,
              eventCountBucketPrev: u.counters.prev,
              lastCounterResetAt: u.counters.resetAt,
            })
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.id, u.contactId),
                eq(contacts.lifecycleState, u.expected.state),
                u.expected.lastSeenAt
                  ? sql`date_trunc('milliseconds', ${contacts.lastSeenAt}) = ${u.expected.lastSeenAt.toISOString()}::timestamptz`
                  : sql`${contacts.lastSeenAt} IS NULL`,
              ),
            )
            .returning({ id: contacts.id });
          if (updated.length === 0) return false;
          await tx
            .delete(lifecycleTransitions)
            .where(and(eq(lifecycleTransitions.tenantId, tenantId), eq(lifecycleTransitions.contactId, u.contactId), sql`${lifecycleTransitions.metadata}->>'source' = 'import'`));
          if (u.transitions.length > 0) {
            await tx.insert(lifecycleTransitions).values(
              u.transitions.map((t) => ({
                tenantId,
                contactId: u.contactId,
                fromState: t.from,
                toState: t.to,
                metadata: { source: "import", trigger: t.trigger },
                transitionedAt: t.at,
              })),
            );
          }
          return true;
        });
        if (ok) applied++;
      }
      return { applied, skipped: updates.length - applied };
    },

    async listSegmentFlows(tenantId) {
      const rows = await db
        .select({ slug: flows.slug, name: flows.name, status: flows.status, triggerConfig: flows.triggerConfig })
        .from(flows)
        .where(and(eq(flows.tenantId, tenantId), eq(flows.triggerType, "segment")));
      return rows.map((r) => ({ ...r, status: r.status ?? "draft" }));
    },
  };
}

class DuplicateImport extends Error {}
