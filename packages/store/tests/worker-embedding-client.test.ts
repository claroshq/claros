/**
 * Contract tests for the workerEmbeddingClient store area (packages/worker/src/worker-embedding-client.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`workerEmbeddingClient on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getActiveLlmConfig returns the tenant's active config, null when none is active", async () => {
      const t = await b.newTenant();
      const inactiveOnly = await b.newTenant();
      const none = await b.newTenant();
      const createdAt = new Date("2026-02-01T00:00:00.000Z");
      await b.db.insert(b.schema.llmConfigs).values([
        { tenantId: t, provider: "openai", config: "old-envelope", isActive: false },
        { tenantId: t, provider: "anthropic", config: '{"iv":"a","data":"b"}', createdAt },
        { tenantId: inactiveOnly, provider: "openai", config: "x", isActive: false },
      ]);
      const row = await b.store.workerEmbeddingClient.getActiveLlmConfig(t);
      expect(row).toMatchObject({
        id: expect.any(String),
        tenantId: t,
        provider: "anthropic",
        config: '{"iv":"a","data":"b"}',
        isActive: true,
        createdAt,
      });
      expect(await b.store.workerEmbeddingClient.getActiveLlmConfig(inactiveOnly)).toBeNull();
      expect(await b.store.workerEmbeddingClient.getActiveLlmConfig(none)).toBeNull();
    });
  });
}
