/**
 * Contract tests for the apiSuppressions store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`apiSuppressions on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const rowsOf = (tenantId: string) =>
      b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, tenantId));

    it("addManualSuppression inserts once per address, case-insensitively", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      expect(await b.store.apiSuppressions.addManualSuppression({ tenantId: t, email: "Ann@Example.com" })).toBe(true);
      expect(await b.store.apiSuppressions.addManualSuppression({ tenantId: t, email: "ann@example.com" })).toBe(false);
      expect(await b.store.apiSuppressions.addManualSuppression({ tenantId: other, email: "ann@example.com" })).toBe(true);
      const rows = await rowsOf(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email: "Ann@Example.com", reason: "manual", source: "admin" });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("addManualSuppression: concurrent inserts of the same address, exactly one wins", async () => {
      const t = await b.newTenant();
      const results = await Promise.all(
        ["x@example.com", "X@example.com", "x@EXAMPLE.com", "x@example.com"].map((email) =>
          b.store.apiSuppressions.addManualSuppression({ tenantId: t, email }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await rowsOf(t)).toHaveLength(1);
    });

    it("importSuppressions skips existing and within-batch duplicates (first wins) and counts inserts", async () => {
      const t = await b.newTenant();
      await b.store.apiSuppressions.addManualSuppression({ tenantId: t, email: "old@example.com" });
      const bulk = Array.from({ length: 120 }, (_, i) => `user${i}@example.com`);
      const n = await b.store.apiSuppressions.importSuppressions({
        tenantId: t,
        emails: ["OLD@example.com", "New@example.com", "new@example.com", ...bulk, "USER5@example.com"],
      });
      expect(n).toBe(121);
      const rows = await rowsOf(t);
      expect(rows).toHaveLength(122);
      const byLower = new Map(rows.map((r: any) => [r.email.toLowerCase(), r]));
      expect(byLower.get("old@example.com")).toMatchObject({ email: "old@example.com", reason: "manual" });
      expect(byLower.get("new@example.com")).toMatchObject({ email: "New@example.com", reason: "imported", source: "csv_import" });
      expect(byLower.get("user5@example.com")).toMatchObject({ email: "user5@example.com" });
      expect(await b.store.apiSuppressions.importSuppressions({ tenantId: t, emails: ["new@EXAMPLE.com"] })).toBe(0);
    });

    it("importSuppressions: concurrent imports insert each address once", async () => {
      const t = await b.newTenant();
      const emails = Array.from({ length: 60 }, (_, i) => `c${i}@example.com`);
      const [a, c] = await Promise.all([
        b.store.apiSuppressions.importSuppressions({ tenantId: t, emails }),
        b.store.apiSuppressions.importSuppressions({ tenantId: t, emails: emails.map((e) => e.toUpperCase()) }),
      ]);
      expect(a + c).toBe(60);
      expect(await rowsOf(t)).toHaveLength(60);
    });

    it("listSuppressions pages by (created_at ms, id)", async () => {
      const t = await b.newTenant();
      await b.store.apiSuppressions.addManualSuppression({ tenantId: await b.newTenant(), email: "foreign@example.com" });
      const base = Date.UTC(2026, 0, 1, 0, 0, 0, 999);
      for (const [i, at] of [base + 2, base, base + 1, base + 1, base + 3].entries()) {
        await b.db.insert(b.schema.suppressions).values({
          id: randomUUID(),
          tenantId: t,
          email: `s${i}@example.com`,
          reason: "manual",
          source: "admin",
          createdAt: new Date(at),
        });
      }
      const all = await b.store.apiSuppressions.listSuppressions({ tenantId: t, after: null, limit: 10 });
      expect(all.map((r) => r.createdAt!.getTime())).toEqual([base, base + 1, base + 1, base + 2, base + 3]);
      expect(all[1]!.id < all[2]!.id).toBe(true);
      expect(all[0]).toMatchObject({ tenantId: t, email: "s1@example.com", reason: "manual", source: "admin" });

      const seen: string[] = [];
      let after: { createdAt: string; id: string } | null = null;
      for (let i = 0; i < 5; i++) {
        const page = await b.store.apiSuppressions.listSuppressions({ tenantId: t, after, limit: 2 });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        const last = page[page.length - 1]!;
        after = { createdAt: last.createdAt!.toISOString(), id: last.id };
      }
      expect(seen).toEqual(all.map((r) => r.id));
    });
  });
}
