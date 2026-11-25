/**
 * Contract tests for the emailLayouts store area (every backend): create,
 * read, list newest first, partial update, delete, and tenant scoping.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

for (const backend of testBackends()) {
  describe(`emailLayouts (${backend.name})`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await backend.open();
    }, 60_000);
    afterAll(async () => {
      await b?.close();
    });

    const source = "<html><body>{{body}}{{compliance_footer}}</body></html>";

    it("creates, reads, lists, updates and deletes a template", async () => {
      const t = await b.newTenant();
      const s = b.store.emailLayouts;
      expect(await s.listLayouts(t)).toEqual([]);

      const t1 = new Date("2026-11-25T10:00:00.000Z");
      const a = await s.createLayout({ tenantId: t, name: "A", description: null, width: "narrow", source, basedOn: "classic", now: t1 });
      const t2 = new Date("2026-11-25T11:00:00.000Z");
      const c = await s.createLayout({ tenantId: t, name: "C", description: "d", width: "wide", source, basedOn: null, now: t2 });
      expect(await s.getLayout({ tenantId: t, id: a.id })).toEqual({ id: a.id, tenantId: t, name: "A", description: null, width: "narrow", source, basedOn: "classic", createdAt: t1, updatedAt: t1 });
      expect((await s.listLayouts(t)).map((r) => r.name)).toEqual(["C", "A"]);

      const t3 = new Date("2026-11-25T12:00:00.000Z");
      const updated = await s.updateLayout({ tenantId: t, id: a.id, patch: { name: "A2", source: source + "<!-- x -->" }, now: t3 });
      expect(updated).toMatchObject({ name: "A2", description: null, width: "narrow", source: source + "<!-- x -->", basedOn: "classic", createdAt: t1, updatedAt: t3 });
      expect((await s.listLayouts(t)).map((r) => r.name)).toEqual(["A2", "C"]);
      expect(await s.updateLayout({ tenantId: t, id: randomUUID(), patch: { name: "x" }, now: t3 })).toBeNull();

      expect(await s.deleteLayout({ tenantId: t, id: c.id })).toBe(true);
      expect(await s.deleteLayout({ tenantId: t, id: c.id })).toBe(false);
      expect(await s.getLayout({ tenantId: t, id: c.id })).toBeNull();
    });

    it("never crosses products", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const s = b.store.emailLayouts;
      const row = await s.createLayout({ tenantId: t, name: "Mine", description: null, width: "narrow", source, basedOn: null, now: new Date() });
      expect(await s.getLayout({ tenantId: other, id: row.id })).toBeNull();
      expect(await s.listLayouts(other)).toEqual([]);
      expect(await s.updateLayout({ tenantId: other, id: row.id, patch: { name: "Theirs" }, now: new Date() })).toBeNull();
      expect(await s.deleteLayout({ tenantId: other, id: row.id })).toBe(false);
      expect((await s.getLayout({ tenantId: t, id: row.id }))!.name).toBe("Mine");
    });
  });
}
