/**
 * Instance keys and instance-wide people lookup (item 11) on every backend:
 * create/list/revoke instance keys, instance key lookup by hash (admin keys
 * never match), product lookup by slug, people by email ignoring case, and
 * a product created without an owner membership.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`instance keys and people (${factory.name})`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("creates, lists, finds and revokes an instance key", async () => {
      const hash = `h-${randomUUID()}`;
      const now = new Date("2026-11-25T10:00:00Z");
      const created = await b.store.apiInstance.createInstanceKey({ keyHash: hash, prefix: "clr_ik_a", label: "ops", scopes: ["products:write", "instance:read"], now });
      expect(created).toMatchObject({ prefix: "clr_ik_a", label: "ops", scopes: ["products:write", "instance:read"], revokedAt: null });
      expect(created.createdAt?.getTime()).toBe(now.getTime());

      const listed = await b.store.apiInstance.listInstanceKeys();
      expect(listed.find((k) => k.id === created.id)).toMatchObject({ scopes: ["products:write", "instance:read"] });

      expect(await b.store.apiAdminAuth.findActiveInstanceKeyByHash(hash)).toEqual({ id: created.id, scopes: ["products:write", "instance:read"] });

      const revoked = await b.store.apiInstance.revokeInstanceKey({ id: created.id, now });
      expect(revoked?.revokedAt?.getTime()).toBe(now.getTime());
      const again = await b.store.apiInstance.revokeInstanceKey({ id: created.id, now: new Date(now.getTime() + 1000) });
      expect(again?.revokedAt?.getTime()).toBe(now.getTime());
      expect(await b.store.apiAdminAuth.findActiveInstanceKeyByHash(hash)).toBeNull();
      expect(await b.store.apiInstance.revokeInstanceKey({ id: randomUUID(), now })).toBeNull();
    });

    it("never treats a product admin key as an instance key, nor the reverse", async () => {
      const tenantId = await b.newTenant();
      const hash = `h-${randomUUID()}`;
      await b.db.insert(b.schema.apiKeys).values({ id: randomUUID(), tenantId, keyHash: hash, prefix: "clr_ak_x", kind: "admin", scopes: ["config"] });
      expect(await b.store.apiAdminAuth.findActiveInstanceKeyByHash(hash)).toBeNull();
      expect(await b.store.apiAdminAuth.findActiveAdminKeyByHash(hash)).not.toBeNull();
      const ik = await b.store.apiInstance.createInstanceKey({ keyHash: `h-${randomUUID()}`, prefix: "clr_ik_b", label: null, scopes: ["instance:read"], now: new Date() });
      const revokeOther = await b.store.apiInstance.revokeInstanceKey({ id: ik.id, now: new Date() });
      expect(revokeOther?.id).toBe(ik.id);
    });

    it("finds a product by slug", async () => {
      const tenantId = await b.newTenant();
      const [t] = await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.id, tenantId));
      expect(await b.store.apiAdminAuth.findProductBySlug(t.slug)).toEqual({ id: tenantId, slug: t.slug, archivedAt: null });
      expect(await b.store.apiAdminAuth.findProductBySlug(`nope-${randomUUID()}`)).toBeNull();
    });

    it("finds a person by email in every product, ignoring case", async () => {
      const a = await b.newTenant();
      const c = await b.newTenant();
      const email = `Erase-${randomUUID().slice(0, 8)}@Example.com`;
      const ca = randomUUID();
      const cc = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id: ca, tenantId: a, externalId: "u1", email, lifecycleState: "signed_up" });
      await b.db.insert(b.schema.contacts).values({ id: cc, tenantId: c, externalId: "u2", email: email.toLowerCase(), lifecycleState: "signed_up" });
      await b.db.insert(b.schema.contacts).values({ id: randomUUID(), tenantId: c, externalId: "u3", email: `other-${email}`, lifecycleState: "signed_up" });
      const rows = await b.store.apiInstance.findPeopleByEmail(email.toUpperCase());
      expect(rows.map((r) => r.contactId).sort()).toEqual([ca, cc].sort());
      expect(rows.find((r) => r.contactId === ca)).toMatchObject({ tenantId: a, externalId: "u1" });
    });

    it("creates a product without an owner membership", async () => {
      const slug = `p-${randomUUID().slice(0, 8)}`;
      const p = await b.store.apiProducts.create({ name: "Keyed", slug, locale: null, ownerUserId: null });
      expect(p).toMatchObject({ slug, name: "Keyed" });
      const ms = await b.db.select().from(b.schema.memberships).where(eq(b.schema.memberships.tenantId, p!.id));
      expect(ms).toHaveLength(0);
      expect(await b.store.apiProducts.create({ name: "Dup", slug, locale: null, ownerUserId: null })).toBeNull();
    });
  });
}
