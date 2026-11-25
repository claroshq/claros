/**
 * Contract tests for the apiInvite store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addMembership, addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiInvite on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function addInvite(tenantId: string, values: Record<string, unknown> = {}) {
      const inviter = await addUser(b, tenantId, { role: "owner" });
      const tokenHash = `inv-${randomUUID()}`;
      await b.db.insert(b.schema.invites).values({
        tenantId,
        email: uniqueEmail("inv"),
        role: "member",
        tokenHash,
        invitedBy: inviter,
        expiresAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 2)),
        ...values,
      });
      return tokenHash;
    }

    const membershipsOf = (userId: string) =>
      b.db
        .select({ tenantId: b.schema.memberships.tenantId, role: b.schema.memberships.role })
        .from(b.schema.memberships)
        .where(eq(b.schema.memberships.userId, userId));
    const userRow = async (id: string) => (await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, id)))[0];

    it("findInviteByTokenHash and findTenantName", async () => {
      const t = await b.newTenant("Invite Co");
      const email = uniqueEmail();
      const tokenHash = await addInvite(t, { email });
      expect(await b.store.apiInvite.findInviteByTokenHash(tokenHash)).toEqual({
        email,
        expiresAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 2)),
        acceptedAt: null,
        tenantId: t,
      });
      expect(await b.store.apiInvite.findInviteByTokenHash("nope")).toBeNull();
      expect(await b.store.apiInvite.findTenantName(t)).toBe("Invite Co");
      expect(await b.store.apiInvite.findTenantName(randomUUID())).toBeNull();
    });

    it("consumeInvite consumes once (expired invites too)", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      const expiresAt = new Date(Date.UTC(2020, 0, 1));
      const tokenHash = await addInvite(t, { email, role: "owner", expiresAt });
      const now = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 1));
      expect(await b.store.apiInvite.consumeInvite({ tokenHash, now })).toEqual({
        id: expect.any(String),
        email,
        role: "owner",
        tenantId: t,
        expiresAt,
      });
      expect(await b.store.apiInvite.consumeInvite({ tokenHash, now })).toBeNull();
      expect((await b.store.apiInvite.findInviteByTokenHash(tokenHash))!.acceptedAt).toEqual(now);
    });

    it("consumeInvite: concurrent consumers, exactly one wins", async () => {
      const t = await b.newTenant();
      const tokenHash = await addInvite(t);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => b.store.apiInvite.consumeInvite({ tokenHash, now: new Date() })),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("findUserByEmail is scoped to the tenant and returns deactivated users", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const email = uniqueEmail();
      const deactivatedAt = new Date(Date.UTC(2026, 2, 3));
      const u = await addUser(b, t, { email, deactivatedAt });
      await addUser(b, other, { email });
      expect(await b.store.apiInvite.findUserByEmail({ tenantId: t, email })).toEqual({ id: u, deactivatedAt });
      expect(await b.store.apiInvite.findUserByEmail({ tenantId: await b.newTenant(), email })).toBeNull();
    });

    it("reactivateUser clears deactivation, sets role and login, upserts the membership", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t, { role: "member", deactivatedAt: new Date() });
      const now = new Date(Date.UTC(2026, 3, 4, 5, 6, 7, 8));
      await b.store.apiInvite.reactivateUser({ userId: u, tenantId: t, role: "owner", now });
      expect(await userRow(u)).toMatchObject({ deactivatedAt: null, role: "owner", lastLoginAt: now });
      expect(await membershipsOf(u)).toEqual([{ tenantId: t, role: "owner" }]);
      await b.store.apiInvite.reactivateUser({ userId: u, tenantId: t, role: "member", now });
      expect(await membershipsOf(u)).toEqual([{ tenantId: t, role: "member" }]);
    });

    it("createUser inserts the user and its membership; a duplicate writes nothing", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      const now = new Date(Date.UTC(2026, 3, 4));
      const id = await b.store.apiInvite.createUser({ tenantId: t, email, role: "member", now });
      expect(await userRow(id)).toMatchObject({ tenantId: t, email, role: "member", lastLoginAt: now, instanceRole: null });
      expect(await membershipsOf(id)).toEqual([{ tenantId: t, role: "member" }]);

      await expect(b.store.apiInvite.createUser({ tenantId: t, email, role: "owner", now })).rejects.toThrow();
      const users = await b.db.select().from(b.schema.users).where(eq(b.schema.users.tenantId, t));
      expect(users).toHaveLength(1);
      const ms = await b.db.select().from(b.schema.memberships).where(eq(b.schema.memberships.tenantId, t));
      expect(ms).toHaveLength(1);
    });

    it("findActiveUserElsewhere: active user of another tenant, oldest first", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      expect(await b.store.apiInvite.findActiveUserElsewhere({ tenantId: t, email })).toBeNull();
      await addUser(b, t, { email }); // same tenant: ignored
      await addUser(b, await b.newTenant(), { email, deactivatedAt: new Date(), createdAt: new Date(Date.UTC(2025, 0, 1)) });
      await addUser(b, await b.newTenant(), { email, createdAt: null });
      const newer = await addUser(b, await b.newTenant(), { email, createdAt: new Date(Date.UTC(2026, 0, 2)) });
      expect(await b.store.apiInvite.findActiveUserElsewhere({ tenantId: t, email })).toEqual({ id: newer });
      const older = await addUser(b, await b.newTenant(), { email, createdAt: new Date(Date.UTC(2026, 0, 1)) });
      expect(await b.store.apiInvite.findActiveUserElsewhere({ tenantId: t, email })).toEqual({ id: older });
    });

    it("addMembership upserts the membership and stamps the login time", async () => {
      const home = await b.newTenant();
      const t = await b.newTenant();
      const u = await addUser(b, home, { role: "owner" });
      await addMembership(b, u, home, "owner");
      const now = new Date(Date.UTC(2026, 5, 6));
      await b.store.apiInvite.addMembership({ userId: u, tenantId: t, role: "member", now });
      await b.store.apiInvite.addMembership({ userId: u, tenantId: t, role: "owner", now });
      const rows = await b.db
        .select({ role: b.schema.memberships.role })
        .from(b.schema.memberships)
        .where(and(eq(b.schema.memberships.userId, u), eq(b.schema.memberships.tenantId, t)));
      expect(rows).toEqual([{ role: "owner" }]);
      expect(await userRow(u)).toMatchObject({ tenantId: home, role: "owner", lastLoginAt: now });
    });

    it("createSession returns the new session id", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t);
      const id = await b.store.apiInvite.createSession({ tenantId: t, userId: u, expiresAt: new Date(Date.UTC(2030, 0, 1)) });
      const rows = await b.db.select().from(b.schema.sessions).where(eq(b.schema.sessions.id, id));
      expect(rows).toHaveLength(1);
    });
  });
}
