/**
 * Postgres implementation of ../areas/api-import.ts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { contacts, flows, flowMemberships, kbEntries, lifecycleMessages } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiImportQueries, HistoryImportResult } from "../areas/api-import.js";

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
  };
}

class DuplicateImport extends Error {}
