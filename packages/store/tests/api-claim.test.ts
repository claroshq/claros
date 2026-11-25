/**
 * Contract tests for the apiClaim store area (every backend).
 *
 * users and tenants are instance-wide; the shared Postgres holds other
 * tests' rows, so global reads are compared with a direct query.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiClaim on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("anyUserExists reflects the users table", async () => {
      const before = (await b.db.select().from(b.schema.users).limit(1)).length > 0;
      expect(await b.store.apiClaim.anyUserExists()).toBe(before);
      await addUser(b, await b.newTenant());
      expect(await b.store.apiClaim.anyUserExists()).toBe(true);
    });

    it("findDefaultTenantId returns the tenant with slug default", async () => {
      const direct = async () =>
        (await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.slug, "default")))[0]?.id ?? null;
      expect(await b.store.apiClaim.findDefaultTenantId()).toBe(await direct());
      if (b.name === "d1") {
        // The fresh D1 database has no default tenant; the shared Postgres is left alone.
        expect(await b.store.apiClaim.findDefaultTenantId()).toBeNull();
        await b.db.insert(b.schema.tenants).values({ name: "Default", slug: "default" });
        expect(await b.store.apiClaim.findDefaultTenantId()).toBe(await direct());
        expect(await b.store.apiClaim.findDefaultTenantId()).not.toBeNull();
      }
    });

    it("createOwnerUser inserts an instance-admin owner with an owner membership; a conflict returns null", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail("owner");
      const id = await b.store.apiClaim.createOwnerUser({ tenantId: t, email });
      expect(id).toEqual(expect.any(String));
      const [u] = await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, id));
      expect(u).toMatchObject({ tenantId: t, email, role: "owner", instanceRole: "admin", deactivatedAt: null });
      expect(u.createdAt).toBeInstanceOf(Date);
      const m = await b.db.select().from(b.schema.memberships).where(eq(b.schema.memberships.userId, id));
      expect(m).toEqual([{ userId: id, tenantId: t, role: "owner", createdAt: expect.any(Date) }]);

      expect(await b.store.apiClaim.createOwnerUser({ tenantId: t, email })).toBeNull();
      expect(await b.db.select().from(b.schema.users).where(eq(b.schema.users.tenantId, t))).toHaveLength(1);
    });

    it("createOwnerUser: concurrent claims, exactly one user and one membership", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail("race");
      const results = await Promise.all(
        Array.from({ length: 5 }, () => b.store.apiClaim.createOwnerUser({ tenantId: t, email })),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const users = await b.db.select().from(b.schema.users).where(eq(b.schema.users.tenantId, t));
      expect(users.map((u: { id: string }) => u.id)).toEqual(winners);
      const m = await b.db
        .select()
        .from(b.schema.memberships)
        .where(and(eq(b.schema.memberships.tenantId, t), eq(b.schema.memberships.userId, winners[0]!)));
      expect(m).toHaveLength(1);
    });

    it("createSession returns the new session id", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t);
      const expiresAt = new Date(Date.UTC(2030, 0, 1));
      const id = await b.store.apiClaim.createSession({ tenantId: t, userId: u, expiresAt });
      const [s] = await b.db.select().from(b.schema.sessions).where(eq(b.schema.sessions.id, id));
      expect(s).toMatchObject({ tenantId: t, userId: u, expiresAt });
    });
  });
}
