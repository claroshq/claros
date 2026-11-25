/**
 * Contract tests for the apiProducts store area (every backend).
 *
 * tenants are instance-wide; the shared Postgres holds other tests' rows, so
 * listAll is checked on this test's products only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addMembership, addTenant, addUser } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiProducts on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const slug = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}`;
    const d = (day: number) => new Date(Date.UTC(2026, 0, day));

    it("listForUser: home product (users.role) plus memberships, oldest first, then slug, NULL created_at last", async () => {
      const home = await addTenant(b, { slug: slug("pb"), createdAt: d(2), locale: "en", publicHost: `${randomUUID()}.example.com` });
      const m1 = await addTenant(b, { slug: slug("pa"), createdAt: d(2), archivedAt: d(9) });
      const m2 = await addTenant(b, { slug: slug("pc"), createdAt: d(1) });
      const nul = await addTenant(b, { slug: slug("pd"), createdAt: null });
      const notMine = await addTenant(b, { slug: slug("pe"), createdAt: d(1) });
      const u = await addUser(b, home.id, { role: "owner" });
      await addMembership(b, u, home.id, "member"); // stale: users.role wins at home
      await addMembership(b, u, m1.id, "member");
      await addMembership(b, u, m2.id, "owner");
      await addMembership(b, u, nul.id, "member");
      void notMine;

      const rows = await b.store.apiProducts.listForUser({ userId: u });
      // Equal created_at: slug order (m1's "pa-" before home's "pb-").
      expect(rows.map((r) => [r.id, r.role])).toEqual([
        [m2.id, "owner"],
        [m1.id, "member"],
        [home.id, "owner"],
        [nul.id, "member"],
      ]);
      const h = rows.find((r) => r.id === home.id)!;
      expect(h).toMatchObject({ slug: home.slug, name: "T", locale: "en", archivedAt: null, createdAt: d(2) });
      expect(h.publicHost).toMatch(/\.example\.com$/);
      expect(rows.find((r) => r.id === m1.id)!.archivedAt).toEqual(d(9));
      expect(await b.store.apiProducts.listForUser({ userId: randomUUID() })).toEqual([]);
    });

    it("listAll: every product, oldest first, then slug, NULL created_at last", async () => {
      const ids = [
        await addTenant(b, { slug: slug("la-z"), createdAt: null }),
        await addTenant(b, { slug: slug("la-b"), createdAt: d(3) }),
        await addTenant(b, { slug: slug("la-a"), createdAt: d(3) }),
        await addTenant(b, { slug: slug("la-c"), createdAt: d(2) }),
      ].map((t) => t.id);
      const mine = new Set(ids);
      const rows = (await b.store.apiProducts.listAll()).filter((r) => mine.has(r.id));
      expect(rows.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
      expect(Object.keys(rows[0]!).sort()).toEqual(["archivedAt", "createdAt", "id", "locale", "name", "publicHost", "slug"]);
    });

    it("create inserts the product and the creator's owner membership; a taken slug is null", async () => {
      const home = await b.newTenant();
      const u = await addUser(b, home);
      const s = slug("new");
      const p = await b.store.apiProducts.create({ name: "New", slug: s, locale: "de", ownerUserId: u });
      expect(p).toEqual({
        id: expect.any(String), slug: s, name: "New", locale: "de", publicHost: null, archivedAt: null, createdAt: expect.any(Date),
      });
      const m = await b.db
        .select({ role: b.schema.memberships.role })
        .from(b.schema.memberships)
        .where(and(eq(b.schema.memberships.userId, u), eq(b.schema.memberships.tenantId, p!.id)));
      expect(m).toEqual([{ role: "owner" }]);
      const [t] = await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.id, p!.id));
      expect(t).toMatchObject({ plan: "free", configVersion: 0 });

      const other = await addUser(b, home);
      expect(await b.store.apiProducts.create({ name: "Dup", slug: s, locale: null, ownerUserId: other })).toBeNull();
      const ms = await b.db.select().from(b.schema.memberships).where(eq(b.schema.memberships.tenantId, p!.id));
      expect(ms).toHaveLength(1);
    });

    it("create: concurrent creates of one slug, exactly one product and one membership", async () => {
      const home = await b.newTenant();
      const creators = await Promise.all(Array.from({ length: 5 }, () => addUser(b, home)));
      const s = slug("race");
      const results = await Promise.all(
        creators.map((ownerUserId) => b.store.apiProducts.create({ name: "R", slug: s, locale: null, ownerUserId })),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const tenants = await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.slug, s));
      expect(tenants.map((t: { id: string }) => t.id)).toEqual([winners[0]!.id]);
      const ms = await b.db.select().from(b.schema.memberships).where(eq(b.schema.memberships.tenantId, winners[0]!.id));
      expect(ms).toHaveLength(1);
    });

    it("update: changes given fields, bumps config_version, maps a taken host and an unknown slug", async () => {
      const a = await addTenant(b, { name: "A", locale: "en" });
      const c = await addTenant(b);
      const host = `${randomUUID()}.example.com`;
      const r1 = await b.store.apiProducts.update({ slug: a.slug, name: "Renamed", publicHost: host });
      expect(r1).toEqual({ ok: true, product: expect.objectContaining({ id: a.id, name: "Renamed", locale: "en", publicHost: host }) });
      const r2 = await b.store.apiProducts.update({ slug: a.slug, locale: null });
      expect(r2).toEqual({ ok: true, product: expect.objectContaining({ name: "Renamed", locale: null, publicHost: host }) });
      const [t] = await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.id, a.id));
      expect(t.configVersion).toBe(2);

      expect(await b.store.apiProducts.update({ slug: c.slug, publicHost: host })).toEqual({ ok: false, reason: "public_host_taken" });
      expect(await b.store.apiProducts.update({ slug: `nope-${randomUUID()}`, name: "Z" })).toEqual({ ok: false, reason: "not_found" });
      // Clearing the host frees it.
      expect((await b.store.apiProducts.update({ slug: a.slug, publicHost: null })).ok).toBe(true);
      expect((await b.store.apiProducts.update({ slug: c.slug, publicHost: host })).ok).toBe(true);
    });

    it("setArchived sets and clears archived_at; unknown slug is null", async () => {
      const a = await addTenant(b);
      const at = new Date(Date.UTC(2026, 5, 1, 0, 0, 0, 4));
      expect(await b.store.apiProducts.setArchived({ slug: a.slug, archivedAt: at })).toMatchObject({ id: a.id, archivedAt: at });
      expect(await b.store.apiProducts.setArchived({ slug: a.slug, archivedAt: null })).toMatchObject({ id: a.id, archivedAt: null });
      expect(await b.store.apiProducts.setArchived({ slug: `nope-${randomUUID()}`, archivedAt: at })).toBeNull();
    });
  });
}
