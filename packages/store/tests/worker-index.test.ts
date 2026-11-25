/**
 * Contract tests for workerIndex.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`workerIndex on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getAnyTenantSettings returns a tenant's settings object", async () => {
      const t = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ settings: { lifecycle: { x: 1 } } }).where(eq(b.schema.tenants.id, t));
      const row = await b.store.workerIndex.getAnyTenantSettings();
      expect(row).not.toBeNull();
      expect(Object.keys(row!)).toEqual(["settings"]);
      // The D1 database is fresh per test file: this tenant is the only one.
      if (b.name === "d1") expect(row).toEqual({ settings: { lifecycle: { x: 1 } } });
    });
  });
}
