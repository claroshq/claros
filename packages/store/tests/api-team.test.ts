/**
 * Contract tests for the apiTeam store area (every backend): members are
 * active users with a membership of the tenant or whose home product it is;
 * the role is users.role at home, else the membership role.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addMembership, addSession, addTransport, addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiTeam on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    /** Tenant t with: home owner, home member (deactivated), guest member from another product, outsider. */
    async function seedTeam() {
      const t = await b.newTenant();
      const elsewhere = await b.newTenant();
      const d = (day: number) => new Date(Date.UTC(2026, 0, day));
      const owner = await addUser(b, t, { role: "owner", email: uniqueEmail("own"), name: "Own", createdAt: d(2) });
      await addMembership(b, owner, t, "member"); // stale row: users.role wins at home
      const gone = await addUser(b, t, { role: "owner", createdAt: d(1), deactivatedAt: d(3) });
      const guest = await addUser(b, elsewhere, { role: "owner", email: uniqueEmail("guest"), createdAt: d(3) });
      await addMembership(b, guest, t, "member");
      const nullCreated = await addUser(b, elsewhere, { role: "member", createdAt: null });
      await addMembership(b, nullCreated, t, "owner");
      const early = await addUser(b, t, { role: "member", createdAt: d(1), lastLoginAt: d(5) });
      const outsider = await addUser(b, elsewhere, { role: "owner" });
      return { t, elsewhere, owner, gone, guest, nullCreated, early, outsider };
    }

    it("listMembers: active members with their role in the tenant, oldest first, NULL created_at last", async () => {
      const s = await seedTeam();
      const rows = await b.store.apiTeam.listMembers({ tenantId: s.t });
      expect(rows.map((r) => [r.id, r.role])).toEqual([
        [s.early, "member"],
        [s.owner, "owner"],
        [s.guest, "member"],
        [s.nullCreated, "owner"],
      ]);
      expect(rows[0]).toMatchObject({ name: null, lastLoginAt: new Date(Date.UTC(2026, 0, 5)), createdAt: new Date(Date.UTC(2026, 0, 1)) });
      expect(rows[1]).toMatchObject({ name: "Own", lastLoginAt: null });
    });

    it("isActiveMemberEmail, getActiveMember, countActiveOwners", async () => {
      const s = await seedTeam();
      const emailOf = async (id: string) => (await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, id)))[0].email;
      expect(await b.store.apiTeam.isActiveMemberEmail({ tenantId: s.t, email: await emailOf(s.guest) })).toBe(true);
      expect(await b.store.apiTeam.isActiveMemberEmail({ tenantId: s.t, email: await emailOf(s.owner) })).toBe(true);
      expect(await b.store.apiTeam.isActiveMemberEmail({ tenantId: s.t, email: await emailOf(s.gone) })).toBe(false);
      expect(await b.store.apiTeam.isActiveMemberEmail({ tenantId: s.t, email: await emailOf(s.outsider) })).toBe(false);

      expect(await b.store.apiTeam.getActiveMember({ tenantId: s.t, userId: s.owner })).toEqual({ id: s.owner, role: "owner" });
      expect(await b.store.apiTeam.getActiveMember({ tenantId: s.t, userId: s.guest })).toEqual({ id: s.guest, role: "member" });
      expect(await b.store.apiTeam.getActiveMember({ tenantId: s.t, userId: s.gone })).toBeNull();
      expect(await b.store.apiTeam.getActiveMember({ tenantId: s.t, userId: s.outsider })).toBeNull();

      // owner (home) + nullCreated (membership owner); gone is deactivated, guest is owner only at home.
      expect(await b.store.apiTeam.countActiveOwners({ tenantId: s.t })).toBe(2);
      expect(await b.store.apiTeam.countActiveOwners({ tenantId: await b.newTenant() })).toBe(0);
    });

    it("invites: create, list pending (not accepted, not expired, oldest first), delete", async () => {
      const t = await b.newTenant();
      const inviter = await addUser(b, t, { role: "owner" });
      const future = new Date(Date.now() + 86_400_000);
      const make = (email: string, extra: Record<string, unknown> = {}) =>
        b.db.insert(b.schema.invites).values({ tenantId: t, email, role: "member", tokenHash: randomUUID(), invitedBy: inviter, expiresAt: future, ...extra });
      const id = await b.store.apiTeam.createInvite({
        tenantId: t, email: "new@example.com", role: "owner", tokenHash: "th", invitedBy: inviter, expiresAt: future,
      });
      await b.db.update(b.schema.invites).set({ createdAt: new Date(Date.UTC(2026, 0, 2)) }).where(eq(b.schema.invites.id, id));
      await make("old@example.com", { createdAt: new Date(Date.UTC(2026, 0, 1)) });
      await make("nullc@example.com", { createdAt: null });
      await make("expired@example.com", { expiresAt: new Date(Date.now() - 1000) });
      await make("accepted@example.com", { acceptedAt: new Date() });
      const rows = await b.store.apiTeam.listPendingInvites({ tenantId: t });
      expect(rows.map((r) => r.email)).toEqual(["old@example.com", "new@example.com", "nullc@example.com"]);
      expect(rows[1]).toEqual({ id, email: "new@example.com", role: "owner", expiresAt: future, createdAt: new Date(Date.UTC(2026, 0, 2)) });

      expect(await b.store.apiTeam.deleteInvite({ tenantId: await b.newTenant(), id })).toBe(false);
      expect(await b.store.apiTeam.deleteInvite({ tenantId: t, id })).toBe(true);
      expect(await b.store.apiTeam.deleteInvite({ tenantId: t, id })).toBe(false);
    });

    it("getTenantBrand, getUserName, getActiveTransport", async () => {
      const t = await b.newTenant("Team Co");
      const u = await addUser(b, t, { name: "Inviter" });
      expect(await b.store.apiTeam.getTenantBrand({ tenantId: t })).toEqual({ name: "Team Co", settings: null });
      expect(await b.store.apiTeam.getTenantBrand({ tenantId: randomUUID() })).toBeNull();
      expect(await b.store.apiTeam.getUserName({ userId: u })).toBe("Inviter");
      expect(await b.store.apiTeam.getUserName({ userId: randomUUID() })).toBeNull();
      expect(await b.store.apiTeam.getActiveTransport({ tenantId: t })).toBeNull();
      await addTransport(b, t);
      const tr = await b.store.apiTeam.getActiveTransport({ tenantId: t });
      expect(tr).toMatchObject({ provider: "resend", from_email: "from@example.com", from_name: "From" });
      expect(JSON.parse(tr!.config)).toEqual({ apiKey: "k", nested: { a: 1 } });
    });

    const membershipRole = async (userId: string, tenantId: string) =>
      (
        await b.db
          .select({ role: b.schema.memberships.role })
          .from(b.schema.memberships)
          .where(and(eq(b.schema.memberships.userId, userId), eq(b.schema.memberships.tenantId, tenantId)))
      )[0]?.role ?? null;
    const userRow = async (id: string) => (await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, id)))[0];

    it("setRole: home product updates users.role and the membership; other products the membership only", async () => {
      const s = await seedTeam();
      await b.store.apiTeam.setRole({ tenantId: s.t, userId: s.early, role: "owner" });
      expect((await userRow(s.early)).role).toBe("owner");
      expect(await membershipRole(s.early, s.t)).toBe("owner");

      await b.store.apiTeam.setRole({ tenantId: s.t, userId: s.guest, role: "owner" });
      expect(await membershipRole(s.guest, s.t)).toBe("owner");
      await b.store.apiTeam.setRole({ tenantId: s.t, userId: s.guest, role: "member" });
      expect(await membershipRole(s.guest, s.t)).toBe("member");
      expect((await userRow(s.guest)).role).toBe("owner"); // home role unchanged
    });

    it("deactivateMember in a non-home product: membership and that product's sessions go, the user stays active", async () => {
      const s = await seedTeam();
      const here = await addSession(b, s.t, s.guest);
      const home = await addSession(b, s.elsewhere, s.guest);
      await b.store.apiTeam.deactivateMember({ tenantId: s.t, userId: s.guest, now: new Date() });
      expect(await membershipRole(s.guest, s.t)).toBeNull();
      expect((await userRow(s.guest)).deactivatedAt).toBeNull();
      const sessions = await b.db.select({ id: b.schema.sessions.id }).from(b.schema.sessions).where(eq(b.schema.sessions.userId, s.guest));
      expect(sessions).toEqual([{ id: home }]);
      void here;
    });

    it("deactivateMember in the home product: user deactivated, all sessions deleted", async () => {
      const s = await seedTeam();
      const other = await b.newTenant();
      await addMembership(b, s.early, other, "member");
      await addMembership(b, s.early, s.t, "member");
      await addSession(b, s.t, s.early);
      await addSession(b, other, s.early);
      const keep = await addSession(b, s.t, s.owner);
      const now = new Date(Date.UTC(2026, 7, 8, 9, 10, 11, 12));
      await b.store.apiTeam.deactivateMember({ tenantId: s.t, userId: s.early, now });
      expect((await userRow(s.early)).deactivatedAt).toEqual(now);
      expect(await membershipRole(s.early, s.t)).toBeNull();
      expect(await membershipRole(s.early, other)).toBe("member");
      expect(await b.db.select().from(b.schema.sessions).where(eq(b.schema.sessions.userId, s.early))).toEqual([]);
      expect(await b.db.select().from(b.schema.sessions).where(eq(b.schema.sessions.id, keep))).toHaveLength(1);
    });
  });
}
