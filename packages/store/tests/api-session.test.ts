/**
 * Contract tests for the apiSession store area (every backend): product
 * selection by slug, effective role (instance admin, home product,
 * membership), archived products.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addMembership, addSession, addTenant, addUser } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiSession on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const find = (sessionId: string, slug?: string | null) =>
      b.store.apiSession.findSessionWithTenantAndUser(sessionId, slug);

    it("resolves the session's product with the home role when no slug is given", async () => {
      const a = await addTenant(b);
      const u = await addUser(b, a.id, { role: "owner" });
      // A stale membership row in the home product does not override users.role.
      await addMembership(b, u, a.id, "member");
      const expiresAt = new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 7));
      const s = await addSession(b, a.id, u, expiresAt);
      expect(await find(s)).toEqual({
        sessionUserId: u,
        sessionExpiresAt: expiresAt,
        tenantId: a.id,
        tenantSlug: a.slug,
        userRole: "owner",
        userDeactivatedAt: null,
        userInstanceRole: null,
        tenantArchivedAt: null,
      });
      expect(await find(s, null)).toMatchObject({ tenantId: a.id });
    });

    it("switches product by slug with the membership role; no membership or unknown slug is null", async () => {
      const a = await addTenant(b);
      const p = await addTenant(b);
      const c = await addTenant(b);
      const u = await addUser(b, a.id, { role: "owner" });
      await addMembership(b, u, p.id, "member");
      const s = await addSession(b, a.id, u);
      expect(await find(s, p.slug)).toMatchObject({ tenantId: p.id, tenantSlug: p.slug, userRole: "member" });
      expect(await find(s, a.slug)).toMatchObject({ tenantId: a.id, userRole: "owner" });
      expect(await find(s, c.slug)).toBeNull();
      expect(await find(s, `nope-${randomUUID()}`)).toBeNull();
      expect(await find(randomUUID())).toBeNull();
    });

    it("an instance admin acts as owner on every product", async () => {
      const a = await addTenant(b);
      const c = await addTenant(b);
      const admin = await addUser(b, a.id, { role: "member", instanceRole: "admin" });
      const s = await addSession(b, a.id, admin);
      expect(await find(s)).toMatchObject({ tenantId: a.id, userRole: "owner", userInstanceRole: "admin" });
      expect(await find(s, c.slug)).toMatchObject({ tenantId: c.id, userRole: "owner", userInstanceRole: "admin" });
    });

    it("returns archived_at of the product and deactivated_at of the user", async () => {
      const archivedAt = new Date(Date.UTC(2026, 4, 1, 12, 0, 0, 3));
      const deactivatedAt = new Date(Date.UTC(2026, 4, 2));
      const a = await addTenant(b);
      const d = await addTenant(b, { archivedAt });
      const u = await addUser(b, a.id, { role: "owner", deactivatedAt });
      await addMembership(b, u, d.id, "owner");
      const s = await addSession(b, a.id, u);
      expect(await find(s, d.slug)).toMatchObject({ tenantId: d.id, tenantArchivedAt: archivedAt, userDeactivatedAt: deactivatedAt });
    });

    it("a session whose product is not the user's home and has no membership is null", async () => {
      const a = await addTenant(b);
      const other = await addTenant(b);
      const u = await addUser(b, a.id, { role: "owner" });
      const s = await addSession(b, other.id, u);
      expect(await find(s)).toBeNull();
      await addMembership(b, u, other.id, "member");
      expect(await find(s)).toMatchObject({ tenantId: other.id, userRole: "member" });
      await b.db.delete(b.schema.memberships).where(eq(b.schema.memberships.userId, u));
      expect(await find(s)).toBeNull();
    });
  });
}
