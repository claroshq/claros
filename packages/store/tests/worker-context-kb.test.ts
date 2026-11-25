/**
 * Contract tests for workerContextKb. Postgres ranks with pgvector `<=>`;
 * D1 computes cosine similarity in JS over the stored JSON embeddings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const DIM = 1536;
/** A 1536-dim vector with the given leading components (float32-exact values). */
const vec = (...head: number[]) => [...head, ...new Array(DIM - head.length).fill(0)];

for (const factory of testBackends()) {
  describe(`workerContextKb on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function entry(tenantId: string, title: string, embedding: number[] | null, isActive = true) {
      const id = randomUUID();
      await b.db.insert(b.schema.kbEntries).values({ id, tenantId, title, content: `${title} body`, embedding, isActive });
      return id;
    }

    it("findEmbeddedEntryByTitle matches exact title on active, embedded entries", async () => {
      const t = await b.newTenant();
      const id = await entry(t, "Pricing", vec(1));
      await entry(t, "Draft", null);
      await entry(t, "Gone", vec(1), false);
      const q = b.store.workerContextKb;
      expect(await q.findEmbeddedEntryByTitle({ tenantId: t, title: "Pricing" })).toEqual({
        id,
        title: "Pricing",
        content: "Pricing body",
      });
      expect(await q.findEmbeddedEntryByTitle({ tenantId: t, title: "pricing" })).toBeNull();
      expect(await q.findEmbeddedEntryByTitle({ tenantId: t, title: "Draft" })).toBeNull();
      expect(await q.findEmbeddedEntryByTitle({ tenantId: t, title: "Gone" })).toBeNull();
      expect(await q.findEmbeddedEntryByTitle({ tenantId: await b.newTenant(), title: "Pricing" })).toBeNull();
    });

    it("searchSimilarEntries ranks by cosine similarity, closest first, top-k", async () => {
      const t = await b.newTenant();
      const same = await entry(t, "same", vec(1, 0));
      const close = await entry(t, "close", vec(1, 0.5));
      const ortho = await entry(t, "ortho", vec(0, 1));
      const opposite = await entry(t, "opposite", vec(-1, 0));
      await entry(t, "inactive", vec(1, 0), false);
      await entry(t, "unembedded", null);
      await entry(await b.newTenant(), "foreign", vec(1, 0));

      const q = b.store.workerContextKb;
      const rows = await q.searchSimilarEntries({ tenantId: t, queryVector: vec(2, 0), limit: 10, excludeId: null });
      expect(rows.map((r) => r.id)).toEqual([same, close, ortho, opposite]);
      const sims = rows.map((r) => parseFloat(String(r.similarity)));
      expect(sims[0]).toBeCloseTo(1, 6);
      expect(sims[1]).toBeCloseTo(1 / Math.sqrt(1.25), 6);
      expect(sims[2]).toBeCloseTo(0, 6);
      expect(sims[3]).toBeCloseTo(-1, 6);
      expect(rows[0]).toMatchObject({ title: "same", content: "same body" });

      const top2 = await q.searchSimilarEntries({ tenantId: t, queryVector: vec(2, 0), limit: 2, excludeId: same });
      expect(top2.map((r) => r.id)).toEqual([close, ortho]);
    });
  });
}
