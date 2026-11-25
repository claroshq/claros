/** Contract test (every backend): workerDrain.getFlowLabel (G6 link tagging). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { insertFlow } from "./support/worker-fixtures.js";

for (const factory of testBackends()) {
  describe(`workerDrain.getFlowLabel on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("returns slug and name, null slug for dashboard flows, null for unknown flows", async () => {
      const t = await b.newTenant();
      const withSlug = await insertFlow(b, t, { slug: "welcome", name: "Welcome" });
      const without = await insertFlow(b, t, { name: "Dashboard flow" });
      expect(await b.store.workerDrain.getFlowLabel(withSlug)).toEqual({ slug: "welcome", name: "Welcome" });
      expect(await b.store.workerDrain.getFlowLabel(without)).toEqual({ slug: null, name: "Dashboard flow" });
      expect(await b.store.workerDrain.getFlowLabel(randomUUID())).toBeNull();
    });

    it("flow slugs are unique per product, any number of flows may have none", async () => {
      const t = await b.newTenant();
      await insertFlow(b, t, { slug: "dup" });
      await expect(insertFlow(b, t, { slug: "dup" })).rejects.toThrow();
      await insertFlow(b, await b.newTenant(), { slug: "dup" });
      await insertFlow(b, t);
      await insertFlow(b, t);
    });
  });
}
