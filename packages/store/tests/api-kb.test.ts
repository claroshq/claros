/**
 * Contract tests for the apiKb store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const entry = (tenantId: string, title = "Doc") => ({
  tenantId,
  title,
  content: "Body",
  contentType: "markdown",
  source: "manual",
  sourceUrl: null,
  tags: ["a", "b"],
  isActive: true,
});

for (const factory of testBackends()) {
  describe(`apiKb on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("createEntry returns the row; embeddingStatus only written when given", async () => {
      const t = await b.newTenant();
      const plain = await b.store.apiKb.createEntry(entry(t));
      expect(plain).toMatchObject({
        tenantId: t,
        title: "Doc",
        tags: ["a", "b"],
        embedding: null,
        embeddingStatus: null,
        embeddingError: null,
        isActive: true,
      });
      expect(plain!.createdAt).toBeInstanceOf(Date);
      const pending = await b.store.apiKb.createEntry({ ...entry(t), tags: null, embeddingStatus: "pending", isActive: false });
      expect(pending).toMatchObject({ embeddingStatus: "pending", tags: null, isActive: false });
    });

    it("listEntries pages by (created_at ms, id) with a cursor and filters inactive", async () => {
      const t = await b.newTenant();
      await b.store.apiKb.createEntry(entry(await b.newTenant(), "other tenant"));
      const base = Date.UTC(2026, 0, 1, 0, 0, 0, 123);
      // two entries share a created_at (tie broken by id), one inactive
      const specs = [
        { title: "e0", at: base, active: true },
        { title: "e1", at: base + 1, active: true },
        { title: "e2", at: base + 1, active: true },
        { title: "e3", at: base + 2, active: false },
        { title: "e4", at: base + 3, active: true },
      ];
      for (const s of specs) {
        await b.db.insert(b.schema.kbEntries).values({
          ...entry(t, s.title),
          id: randomUUID(),
          isActive: s.active,
          createdAt: new Date(s.at),
        });
      }
      const all = await b.store.apiKb.listEntries({ tenantId: t, includeInactive: true, cursor: null, limit: 10 });
      expect(all).toHaveLength(5);
      const tie = all.filter((r) => r.createdAt!.getTime() === base + 1).map((r) => r.id);
      expect(tie).toEqual([...tie].sort());
      expect(all.map((r) => r.createdAt!.getTime())).toEqual([base, base + 1, base + 1, base + 2, base + 3]);

      // walk pages of 2 over active entries
      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | null = null;
      for (let i = 0; i < 5; i++) {
        const page = await b.store.apiKb.listEntries({ tenantId: t, includeInactive: false, cursor, limit: 2 });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.title));
        const last = page[page.length - 1]!;
        cursor = { createdAt: last.createdAt!.toISOString(), id: last.id };
      }
      const activeOrder = all.filter((r) => r.isActive).map((r) => r.title);
      expect(seen).toEqual(activeOrder);
      expect(seen).not.toContain("e3");

      // cursor in the middle of a tie continues with the second tied row
      const firstTie = all.find((r) => r.id === tie[0])!;
      const rest = await b.store.apiKb.listEntries({
        tenantId: t,
        includeInactive: true,
        cursor: { createdAt: firstTie.createdAt!.toISOString(), id: firstTie.id },
        limit: 10,
      });
      expect(rest.map((r) => r.id)).toEqual(all.slice(2).map((r) => r.id));
    });

    it("findEntry, updateEntry and deleteEntry are tenant scoped", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const row = await b.store.apiKb.createEntry(entry(t));
      expect((await b.store.apiKb.findEntry({ tenantId: t, id: row!.id }))?.title).toBe("Doc");
      expect(await b.store.apiKb.findEntry({ tenantId: other, id: row!.id })).toBeNull();

      const now = new Date(Date.UTC(2026, 5, 6, 7, 8, 9, 10));
      expect(await b.store.apiKb.updateEntry({ tenantId: other, id: row!.id, patch: { updatedAt: now, title: "x" } })).toBeUndefined();
      const updated = await b.store.apiKb.updateEntry({
        tenantId: t,
        id: row!.id,
        patch: { updatedAt: now, title: "New", tags: ["z"], isActive: false, embeddingStatus: "pending", embeddingError: null },
      });
      expect(updated).toMatchObject({ title: "New", tags: ["z"], isActive: false, embeddingStatus: "pending", content: "Body" });
      expect(updated!.updatedAt!.getTime()).toBe(now.getTime());

      await b.store.apiKb.deleteEntry({ tenantId: other, id: row!.id });
      expect(await b.store.apiKb.findEntry({ tenantId: t, id: row!.id })).not.toBeNull();
      await b.store.apiKb.deleteEntry({ tenantId: t, id: row!.id });
      expect(await b.store.apiKb.findEntry({ tenantId: t, id: row!.id })).toBeNull();
    });

    it("listReEmbedCandidateIds: null, failed, and orphaned pending entries without embedding", async () => {
      const t = await b.newTenant();
      const old = new Date(Date.now() - 60 * 60_000);
      const fresh = new Date();
      const vec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      const mk = async (title: string, values: Record<string, unknown>) => {
        const id = randomUUID();
        await b.db.insert(b.schema.kbEntries).values({ ...entry(t, title), id, ...values });
        return id;
      };
      const never = await mk("never", { embeddingStatus: null });
      const failed = await mk("failed", { embeddingStatus: "failed", embeddingError: "dims" });
      const orphan = await mk("orphan", { embeddingStatus: "pending", updatedAt: old });
      const skipped = await mk("skipped", { embeddingStatus: "skipped" });
      await mk("inflight", { embeddingStatus: "pending", updatedAt: fresh });
      await mk("done", { embeddingStatus: null, embedding: vec });
      await b.store.apiKb.createEntry(entry(await b.newTenant(), "other"));

      const ids = await b.store.apiKb.listReEmbedCandidateIds({ tenantId: t, orphanThresholdMinutes: 10 });
      expect([...ids].sort()).toEqual([never, failed, orphan, skipped].sort());
    });

    it("clearEmbeddings drops the tenant's vectors, marks skipped, keeps updated_at", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const old = new Date(Date.UTC(2026, 0, 2));
      const vec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      const mine = randomUUID();
      const failed = randomUUID();
      const fresh = randomUUID();
      const foreign = randomUUID();
      await b.db.insert(b.schema.kbEntries).values([
        { ...entry(t, "mine"), id: mine, embedding: vec, updatedAt: old },
        { ...entry(t, "failed"), id: failed, embeddingStatus: "failed", embeddingError: "x", updatedAt: old },
        { ...entry(t, "fresh"), id: fresh, embedding: vec, embeddingStatus: "pending", updatedAt: new Date() },
        { ...entry(other, "foreign"), id: foreign, embedding: vec },
      ]);
      await b.store.apiKb.clearEmbeddings({ tenantId: t });
      const rows = await b.db.select().from(b.schema.kbEntries).where(inArray(b.schema.kbEntries.id, [mine, failed, fresh, foreign]));
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[mine]).toMatchObject({ embedding: null, embeddingStatus: "skipped", embeddingError: null });
      expect(byId[mine]!.updatedAt!.getTime()).toBe(old.getTime());
      expect(byId[failed]).toMatchObject({ embeddingStatus: "skipped", embeddingError: null });
      expect(byId[foreign]!.embedding).toEqual(vec);
      // Cleared entries are re-embed candidates at once, recently edited ones too.
      const ids = await b.store.apiKb.listReEmbedCandidateIds({ tenantId: t, orphanThresholdMinutes: 15 });
      expect([...ids].sort()).toEqual([mine, failed, fresh].sort());
    });

    it("markEntriesPendingEmbedding updates only the tenant's given entries (more than one chunk)", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await b.store.apiKb.createEntry(entry(t, `e${i}`));
        await b.db
          .update(b.schema.kbEntries)
          .set({ embeddingStatus: "failed", embeddingError: "x" })
          .where(eq(b.schema.kbEntries.id, r!.id));
        ids.push(r!.id);
      }
      const foreign = await b.store.apiKb.createEntry(entry(other, "foreign"));
      const now = new Date(Date.UTC(2026, 6, 7));
      const padding = Array.from({ length: 150 }, () => randomUUID());
      await b.store.apiKb.markEntriesPendingEmbedding({
        tenantId: t,
        ids: [ids[0]!, ...padding, ids[2]!, foreign!.id],
        now,
      });
      const rows = await b.store.apiKb.listEntries({ tenantId: t, includeInactive: true, cursor: null, limit: 10 });
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
      expect(byTitle.e0).toMatchObject({ embeddingStatus: "pending", embeddingError: null });
      expect(byTitle.e0!.updatedAt!.getTime()).toBe(now.getTime());
      expect(byTitle.e1).toMatchObject({ embeddingStatus: "failed", embeddingError: "x" });
      expect(byTitle.e2).toMatchObject({ embeddingStatus: "pending", embeddingError: null });
      expect((await b.store.apiKb.findEntry({ tenantId: other, id: foreign!.id }))?.embeddingStatus).toBeNull();
    });
  });
}
