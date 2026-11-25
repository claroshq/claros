/**
 * Contract tests for the serverMain store area (every backend).
 *
 * The bootstrap seed only acts on an empty instance. The shared Postgres
 * always has tenants, so the fresh-install path (and its race) runs on fresh
 * D1 databases only; the "tenants exist" path runs on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`serverMain on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("bootstrapSeed does nothing when a tenant exists", async () => {
      await b.newTenant();
      const email = uniqueEmail("seed");
      expect(await b.store.serverMain.bootstrapSeed(email)).toEqual({ freshInstall: false, insertedTenant: false, tenantId: null });
      expect(await b.store.serverMain.bootstrapSeed(null)).toEqual({ freshInstall: false, insertedTenant: false, tenantId: null });
      expect(await b.db.select().from(b.schema.users).where(eq(b.schema.users.email, email))).toEqual([]);
    });

    it("hasAnyUser reflects the users table", async () => {
      const before = (await b.db.select().from(b.schema.users).limit(1)).length > 0;
      expect(await b.store.serverMain.hasAnyUser()).toBe(before);
      await addUser(b, await b.newTenant());
      expect(await b.store.serverMain.hasAnyUser()).toBe(true);
    });

    if (factory.name === "d1") {
      async function fresh(run: (f: Backend) => Promise<void>) {
        const f = await factory.open();
        try {
          await run(f);
        } finally {
          await f.close();
        }
      }

      it("fresh install with an owner email: default tenant, instance-admin owner, owner membership", async () => {
        await fresh(async (f) => {
          expect(await f.store.serverMain.hasAnyUser()).toBe(false);
          const res = await f.store.serverMain.bootstrapSeed("admin@example.com");
          expect(res).toEqual({ freshInstall: true, insertedTenant: true, tenantId: expect.any(String) });
          const tenants = await f.db.select().from(f.schema.tenants);
          expect(tenants).toEqual([expect.objectContaining({ id: res.tenantId, name: "Default", slug: "default", plan: "free" })]);
          expect(tenants[0].createdAt).toBeInstanceOf(Date);
          const users = await f.db.select().from(f.schema.users);
          expect(users).toEqual([
            expect.objectContaining({ tenantId: res.tenantId, email: "admin@example.com", role: "owner", instanceRole: "admin" }),
          ]);
          expect(await f.db.select().from(f.schema.memberships)).toEqual([
            { userId: users[0].id, tenantId: res.tenantId, role: "owner", createdAt: expect.any(Date) },
          ]);
          expect(await f.store.serverMain.hasAnyUser()).toBe(true);
          // Second run: tenants exist.
          expect(await f.store.serverMain.bootstrapSeed("admin@example.com")).toEqual({ freshInstall: false, insertedTenant: false, tenantId: null });
        });
      });

      it("fresh install without an owner email: default tenant only", async () => {
        await fresh(async (f) => {
          const res = await f.store.serverMain.bootstrapSeed(null);
          expect(res).toEqual({ freshInstall: true, insertedTenant: true, tenantId: expect.any(String) });
          expect(await f.db.select().from(f.schema.users)).toEqual([]);
          expect(await f.store.serverMain.hasAnyUser()).toBe(false);
        });
      });

      it("fresh install: concurrent seeds insert one tenant, one owner, one membership", async () => {
        await fresh(async (f) => {
          const results = await Promise.all(
            Array.from({ length: 5 }, () => f.store.serverMain.bootstrapSeed("admin@example.com")),
          );
          const inserted = results.filter((r) => r.insertedTenant);
          expect(inserted).toHaveLength(1);
          const tenants = await f.db.select().from(f.schema.tenants);
          expect(tenants.map((t: { id: string }) => t.id)).toEqual([inserted[0]!.tenantId]);
          expect(await f.db.select().from(f.schema.users)).toHaveLength(1);
          expect(await f.db.select().from(f.schema.memberships)).toHaveLength(1);
        });
      });
    }
  });
}
