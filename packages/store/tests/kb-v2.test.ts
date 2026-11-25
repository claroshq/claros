/**
 * Contract tests for KB v2 and the KB import (G15, G18): apiKb.importEntries,
 * findEntryByExternalKey, workerContent.listKbCandidates / listPinnedKb.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { KbImportEntry } from "../src/index.js";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

const t0 = new Date("2026-11-20T12:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

function entry(key: string, over: Partial<KbImportEntry> = {}): KbImportEntry {
  return {
    externalKey: key,
    title: `Title ${key}`,
    content: `Content ${key}`,
    contentType: "markdown",
    category: "tip_trick",
    tags: ["pro"],
    data: { core_insight: key, n: 1 },
    pinned: false,
    isActive: true,
    sourceUrl: null,
    ...over,
  };
}

for (const factory of testBackends()) {
  describe(`KB v2 on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("imports, re-runs idempotently, skips edited rows unless forced, never deletes", async () => {
      const tenantId = await b.newTenant();
      const kb = b.store.apiKb;
      const first = await kb.importEntries({ tenantId, entries: [entry("a"), entry("b")], force: false, dryRun: false, markPending: false, now: t0 });
      expect(first).toMatchObject({ created: 2, updated: 0, unchanged: 0, skipped_edited: 0 });
      expect(first.contentChangedIds).toHaveLength(2);
      const a = await kb.findEntryByExternalKey({ tenantId, externalKey: "a" });
      expect(a).toMatchObject({ title: "Title a", category: "tip_trick", source: "import", pinned: false, data: { core_insight: "a", n: 1 } });
      expect(a!.importedAt).toEqual(t0);

      const again = await kb.importEntries({ tenantId, entries: [entry("a"), entry("b")], force: false, dryRun: false, markPending: false, now: later(1000) });
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2, skipped_edited: 0 });

      // Untouched since import: a changed source overwrites.
      const upd = await kb.importEntries({ tenantId, entries: [entry("a", { content: "New a" })], force: false, dryRun: false, markPending: false, now: later(2000) });
      expect(upd).toMatchObject({ updated: 1 });
      expect(upd.contentChangedIds).toEqual([a!.id]);

      // Edited in Claros since its import: skipped unless forced.
      await kb.updateEntry({ tenantId, id: a!.id, patch: { updatedAt: later(3000), title: "Edited" } });
      const skipped = await kb.importEntries({ tenantId, entries: [entry("a", { content: "Newer a" })], force: false, dryRun: false, markPending: false, now: later(4000) });
      expect(skipped).toMatchObject({ updated: 0, skipped_edited: 1, skipped_keys: ["a"] });
      expect((await kb.findEntryByExternalKey({ tenantId, externalKey: "a" }))!.title).toBe("Edited");
      const dry = await kb.importEntries({ tenantId, entries: [entry("a", { content: "Newer a" }), entry("c")], force: true, dryRun: true, markPending: false, now: later(5000) });
      expect(dry).toMatchObject({ created: 1, updated: 1 });
      expect(await kb.findEntryByExternalKey({ tenantId, externalKey: "c" })).toBeNull();
      const forced = await kb.importEntries({ tenantId, entries: [entry("a", { content: "Newer a" })], force: true, dryRun: false, markPending: true, now: later(6000) });
      expect(forced).toMatchObject({ updated: 1 });
      const fa = await kb.findEntryByExternalKey({ tenantId, externalKey: "a" });
      expect(fa).toMatchObject({ title: "Title a", content: "Newer a", embeddingStatus: "pending" });

      // Re-embedding is not an edit.
      await kb.markEntriesPendingEmbedding({ tenantId, ids: [fa!.id], now: later(7000) });
      const after = await kb.importEntries({ tenantId, entries: [entry("a", { content: "Newest a" })], force: false, dryRun: false, markPending: false, now: later(8000) });
      expect(after).toMatchObject({ updated: 1, skipped_edited: 0 });

      // Entries missing from an import stay.
      expect(await kb.findEntryByExternalKey({ tenantId, externalKey: "b" })).not.toBeNull();
    });

    it("lists category candidates without entries the contact already got (imported history included) and pinned entries", async () => {
      const tenantId = await b.newTenant();
      await b.store.apiKb.importEntries({
        tenantId,
        entries: [entry("x1"), entry("x2"), entry("x3", { isActive: false }), entry("o1", { category: "other" }), entry("facts", { category: "facts", pinned: true })],
        force: false,
        dryRun: false,
        markPending: false,
        now: t0,
      });
      const x1 = (await b.store.apiKb.findEntryByExternalKey({ tenantId, externalKey: "x1" }))!;
      const x2 = (await b.store.apiKb.findEntryByExternalKey({ tenantId, externalKey: "x2" }))!;
      const contactId = await insertContact(b, tenantId);
      const other = await insertContact(b, tenantId);
      const flowId = await insertFlow(b, tenantId);
      const m1 = await insertMembership(b, { tenantId, contactId, flowId, status: "completed" });
      await insertMessage(b, { tenantId, contactId, flowId, membershipId: m1, flowStepOrder: 1, status: "sent", imported: true, kbEntryId: x1.id });
      const m2 = await insertMembership(b, { tenantId, contactId, flowId, status: "completed" });
      await insertMessage(b, { tenantId, contactId, flowId, membershipId: m2, flowStepOrder: 1, status: "rejected", kbEntryId: x2.id });
      const current = await insertMembership(b, { tenantId, contactId, flowId });
      const me = await insertMessage(b, { tenantId, contactId, flowId, membershipId: current, flowStepOrder: 1, status: "generating", kbEntryId: x2.id });

      const wc = b.store.workerContent;
      expect((await wc.listKbCandidates({ tenantId, category: "tip_trick" })).map((e) => e.id).sort()).toEqual([x1.id, x2.id].sort());
      expect((await wc.listKbCandidates({ tenantId, category: "tip_trick", excludeUsedBy: { contactId, exceptMessageId: me } })).map((e) => e.id)).toEqual([x2.id]);
      expect((await wc.listKbCandidates({ tenantId, category: "tip_trick", excludeUsedBy: { contactId: other, exceptMessageId: me } })).map((e) => e.id).sort()).toEqual([x1.id, x2.id].sort());
      const pinned = await wc.listPinnedKb(tenantId);
      expect(pinned.map((e) => e.title)).toEqual(["Title facts"]);

      await wc.saveMessageMeta({ tenantId, messageId: me, meta: { kbEntryId: null, contextSnapshot: { leads: [1] }, openingLine: "Hi", chooseDecision: { choice: "none" } } });
      const [row] = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, me));
      expect(row).toMatchObject({ kbEntryId: null, contextSnapshot: { leads: [1] }, openingLine: "Hi", chooseDecision: { choice: "none" } });
    });

    it("getRenderInfo, getFlowTopicGate and markBlocked", async () => {
      const tenantId = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ locale: "es", settings: { links: { a: "https://a.example" } } }).where(eq(b.schema.tenants.id, tenantId));
      const topicId = crypto.randomUUID();
      await b.db.insert(b.schema.topics).values({ id: topicId, tenantId, slug: "lifecycle", name: "Lifecycle", kind: "lifecycle", defaultSubscribed: true });
      const flowId = await insertFlow(b, tenantId, { slug: "nurture", topicId, flowClass: "critical" });
      const contactId = await insertContact(b, tenantId);
      const wc = b.store.workerContent;
      expect(await wc.getRenderInfo({ tenantId, flowId })).toMatchObject({ locale: "es", flowSlug: "nurture", flowClass: "critical", settings: { links: { a: "https://a.example" } } });
      expect(await wc.getRenderInfo({ tenantId: await b.newTenant(), flowId })).toBeNull();
      expect(await wc.getFlowTopicGate({ tenantId, contactId, flowId })).toEqual({ kind: "lifecycle", defaultSubscribed: true, status: null });
      await b.db.insert(b.schema.contactTopics).values({ tenantId, contactId, topicId, status: "unsubscribed" });
      expect(await wc.getFlowTopicGate({ tenantId, contactId, flowId })).toEqual({ kind: "lifecycle", defaultSubscribed: true, status: "unsubscribed" });
      expect(await wc.getFlowTopicGate({ tenantId, contactId, flowId: await insertFlow(b, tenantId) })).toBeNull();

      const membershipId = await insertMembership(b, { tenantId, contactId, flowId });
      const id = await insertMessage(b, { tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "awaiting_content" });
      const body = { subject: "S", bodyHtml: "<p>x</p>", bodyText: "x" };
      expect(await wc.markBlocked({ messageId: id, fromStatus: "generating", statusReason: "link_not_allowed", reasoning: "r", body, now: t0 })).toBe(false);
      expect(await wc.markBlocked({ messageId: id, fromStatus: "awaiting_content", statusReason: "link_not_allowed", reasoning: "r", body, now: t0 })).toBe(true);
      const [row] = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id));
      expect(row).toMatchObject({ status: "failed", statusReason: "link_not_allowed", subject: "S", brainReasoning: "r" });
    });
  });
}
