/**
 * The test backends themselves: both open, accept the same fixture insert
 * and return timestamps as Date.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`backend ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("inserts and reads a tenant with the shared schema names", async () => {
      const id = await b.newTenant("Acme");
      const rows = await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Acme");
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("has the store dialect matching the backend", () => {
      expect(b.store.dialect).toBe(b.name === "pg" ? "pg" : "sqlite");
    });
  });
}
