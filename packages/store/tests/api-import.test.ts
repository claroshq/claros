/**
 * Contract tests for apiImport.importMessages (G21): resolution by external
 * id or email, idempotency, dry run, errors, and that imported history
 * counts for send history and kb_select exclude_used.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { HistoryImportItem } from "../src/index.js";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow } from "./support/worker-fixtures.js";

const sentAt = new Date("2026-06-01T09:00:00Z");

function item(index: number, over: Partial<HistoryImportItem> = {}): HistoryImportItem {
  return {
    index,
    externalId: "user-1",
    email: null,
    flowSlug: "nurture",
    stepOrder: 1,
    actionType: "tip_trick",
    subject: "A tip",
    sentAt,
    kbExternalKey: "kb:1",
    importKey: `k${index}`,
    ...over,
  };
}

for (const factory of testBackends()) {
  describe(`apiImport on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("imports sent history once, resolving contacts by external id or email", async () => {
      const tenantId = await b.newTenant();
      const c1 = await insertContact(b, tenantId, { externalId: "user-1", email: "one@example.com" });
      const c2 = await insertContact(b, tenantId, { externalId: "user-2", email: "Two@Example.com" });
      const flowId = await insertFlow(b, tenantId, { slug: "nurture" });
      await b.store.apiKb.importEntries({
        tenantId,
        entries: [{ externalKey: "kb:1", title: "T", content: "C", contentType: "markdown", category: "tip_trick", tags: null, data: null, pinned: false, isActive: true, sourceUrl: null }],
        force: false, dryRun: false, markPending: false, now: sentAt,
      });
      const items = [
        item(0),
        item(1, { externalId: null, email: "two@example.com", importKey: "k1" }),
        item(2, { flowSlug: "missing", importKey: "k2" }),
        item(3, { externalId: "nobody", importKey: "k3" }),
        item(4, { kbExternalKey: "kb:404", importKey: "k4" }),
        item(5, { importKey: "k0" }),
      ];
      const dry = await b.store.apiImport.importMessages({ tenantId, items, dryRun: true, now: sentAt });
      expect(dry).toMatchObject({ imported: 2, duplicates: 1 });
      const r = await b.store.apiImport.importMessages({ tenantId, items, dryRun: false, now: sentAt });
      expect(r.imported).toBe(2);
      expect(r.duplicates).toBe(1);
      expect(r.errors.map((e) => e.index)).toEqual([2, 3, 4]);
      const again = await b.store.apiImport.importMessages({ tenantId, items: items.slice(0, 2), dryRun: false, now: sentAt });
      expect(again).toMatchObject({ imported: 0, duplicates: 2 });

      const msgs = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, tenantId));
      expect(msgs).toHaveLength(2);
      expect(msgs.every((m: any) => m.status === "sent" && m.imported === true && new Date(m.sentAt).getTime() === sentAt.getTime())).toBe(true);
      const ms = await b.db.select().from(b.schema.flowMemberships).where(and(eq(b.schema.flowMemberships.tenantId, tenantId), eq(b.schema.flowMemberships.flowId, flowId)));
      expect(ms.map((m: any) => m.status)).toEqual(["completed", "completed"]);
      expect(ms.every((m: any) => m.exitReason === "imported")).toBe(true);

      // History and KB dedup see it.
      expect(await b.store.workerContent.countSends({ tenantId, contactId: c1, actionType: "tip_trick", since: null })).toBe(1);
      expect(await b.store.workerContent.countSends({ tenantId, contactId: c2, flow: "nurture", since: null })).toBe(1);
      expect(await b.store.workerContent.listKbCandidates({ tenantId, category: "tip_trick", excludeUsedBy: { contactId: c1, exceptMessageId: "00000000-0000-0000-0000-000000000000" } })).toEqual([]);
    });
  });
}
