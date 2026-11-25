/**
 * Contract tests for the apiInstance store area (every backend).
 *
 * Instance data is not tenant scoped; the shared Postgres holds other tests'
 * rows, so results are checked on this test's keys and users only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addMembership, addTenant, addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiInstance on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("putSetting inserts and replaces; listSettings returns every setting in key order", async () => {
      const run = randomUUID().slice(0, 8);
      const k1 = `zz-${run}-b`;
      const k2 = `zz-${run}-a`;
      const at1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1));
      const at2 = new Date(Date.UTC(2026, 0, 2));
      expect(await b.store.apiInstance.putSetting({ key: k1, value: { on: true, n: null }, now: at1 })).toEqual({
        key: k1, value: { on: true, n: null }, updatedAt: at1,
      });
      expect(await b.store.apiInstance.putSetting({ key: k2, value: "text", now: at1 })).toEqual({ key: k2, value: "text", updatedAt: at1 });
      expect(await b.store.apiInstance.putSetting({ key: k1, value: [1, 2], now: at2 })).toEqual({ key: k1, value: [1, 2], updatedAt: at2 });
      const mine = (await b.store.apiInstance.listSettings()).filter((s) => s.key.startsWith(`zz-${run}`));
      expect(mine).toEqual([
        { key: k2, value: "text", updatedAt: at1 },
        { key: k1, value: [1, 2], updatedAt: at2 },
      ]);
      await b.db.delete(b.schema.instanceSettings).where(like(b.schema.instanceSettings.key, `zz-${run}%`));
    });

    it("listUsers: every user with memberships (slug order), oldest first, then id, NULL created_at last", async () => {
      const run = randomUUID().slice(0, 8);
      const ta = await addTenant(b, { slug: `ia-${run}` });
      const tb = await addTenant(b, { slug: `ib-${run}` });
      const d = (day: number) => new Date(Date.UTC(2001, 0, day));
      const email = uniqueEmail("inst");
      const multi = await addUser(b, tb.id, { email, name: "Multi", instanceRole: "admin", createdAt: d(2), deactivatedAt: d(5) });
      await addMembership(b, multi, tb.id, "owner");
      await addMembership(b, multi, ta.id, "member");
      const lone = await addUser(b, ta.id, { createdAt: d(1) });
      const late = await addUser(b, ta.id, { createdAt: null });
      const tie1 = await addUser(b, ta.id, { createdAt: d(3) });
      const tie2 = await addUser(b, ta.id, { createdAt: d(3) });
      const ids = [multi, lone, late, tie1, tie2];

      const mine = (await b.store.apiInstance.listUsers()).filter((u) => ids.includes(u.id));
      expect(mine.map((u) => u.id)).toEqual([lone, multi, ...[tie1, tie2].sort(), late]);
      expect(mine[1]).toEqual({
        id: multi,
        email,
        name: "Multi",
        instanceRole: "admin",
        homeTenantId: tb.id,
        deactivatedAt: d(5),
        createdAt: d(2),
        memberships: [
          { tenantId: ta.id, slug: ta.slug, role: "member" },
          { tenantId: tb.id, slug: tb.slug, role: "owner" },
        ],
      });
      expect(mine[0]!.memberships).toEqual([]);
      expect(mine[4]!.createdAt).toBeNull();
    });
  });
}
