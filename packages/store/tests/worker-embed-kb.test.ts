/**
 * Contract tests for the workerEmbedKb store area (packages/worker/src/embed-kb.ts).
 *
 * Embeddings are 1536 floats exactly representable in float32 so the pgvector
 * round trip is lossless.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

const MISSING = "00000000-0000-4000-8000-000000000000";
const VECTOR = Array.from({ length: 1536 }, (_, i) => (i % 97) / 64 - 0.75);

for (const factory of testBackends()) {
  describe(`workerEmbedKb on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const entry = async (id: string) => (await b.db.select().from(b.schema.kbEntries).where(eq(b.schema.kbEntries.id, id)))[0];
    const seedEntry = async (tenantId: string, values: Record<string, unknown> = {}) => {
      const [row] = await b.db
        .insert(b.schema.kbEntries)
        .values({ tenantId, title: "Pricing", content: "Plans and limits", ...values })
        .returning({ id: b.schema.kbEntries.id });
      return row.id as string;
    };

    it("getKbEntry returns the tenant's entry, null otherwise", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await seedEntry(t);
      expect(await b.store.workerEmbedKb.getKbEntry(t, id)).toMatchObject({ id, tenantId: t, title: "Pricing", content: "Plans and limits" });
      expect(await b.store.workerEmbedKb.getKbEntry(other, id)).toBeNull();
      expect(await b.store.workerEmbedKb.getKbEntry(t, MISSING)).toBeNull();
    });

    it("saveEmbedding stores the vector and clears status and error", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await seedEntry(t, { embeddingStatus: "failed", embeddingError: "old" });
      await b.store.workerEmbedKb.saveEmbedding(other, id, VECTOR);
      expect((await entry(id)).embedding).toBeNull();
      await b.store.workerEmbedKb.saveEmbedding(t, id, VECTOR);
      const row = await entry(id);
      expect(row.embedding).toEqual(VECTOR);
      expect(row.embeddingStatus).toBeNull();
      expect(row.embeddingError).toBeNull();
    });

    it("markEmbeddingFailed records the failure for the tenant's entry only", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await seedEntry(t, { embeddingStatus: "pending" });
      await b.store.workerEmbedKb.markEmbeddingFailed(other, id, "nope");
      expect((await entry(id)).embeddingStatus).toBe("pending");
      await b.store.workerEmbedKb.markEmbeddingFailed(t, id, "dimension mismatch");
      expect(await entry(id)).toMatchObject({ embeddingStatus: "failed", embeddingError: "dimension mismatch", embedding: null });
    });
  });
}
