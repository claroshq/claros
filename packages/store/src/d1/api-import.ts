/**
 * SQLite / D1 implementation of ../areas/api-import.ts. Each item is one
 * batch: the membership insert is guarded by the import key being free, and
 * the message insert (ON CONFLICT DO NOTHING on uq_messages_import_key) only
 * runs when the membership insert changed a row.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { contacts, flows, kbEntries, lifecycleMessages } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { rawBatch } from "./raw-batch.js";
import type { ApiImportQueries, HistoryImportResult } from "../areas/api-import.js";

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
  };
}
