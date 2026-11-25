/**
 * Contract tests for the apiAuth store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addSession, addTransport, addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiAuth on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("findActiveTransportConfig / hasActiveTransport read the active transport only", async () => {
      const t = await b.newTenant();
      expect(await b.store.apiAuth.findActiveTransportConfig(t)).toBeNull();
      expect(await b.store.apiAuth.hasActiveTransport(t)).toBe(false);
      await addTransport(b, t, { isActive: false, provider: "smtp" });
      expect(await b.store.apiAuth.findActiveTransportConfig(t)).toBeNull();
      expect(await b.store.apiAuth.hasActiveTransport(t)).toBe(false);
      await addTransport(b, t, { fromName: null });
      const row = await b.store.apiAuth.findActiveTransportConfig(t);
      expect(row).toMatchObject({ provider: "resend", from_email: "from@example.com", from_name: null });
      // config is JSON text; formatting differs (jsonb vs stored text), the parsed value does not.
      expect(typeof row!.config).toBe("string");
      expect(JSON.parse(row!.config)).toEqual({ apiKey: "k", nested: { a: 1 } });
      expect(await b.store.apiAuth.hasActiveTransport(t)).toBe(true);
    });

    it("findUserByEmail prefers an active user, then the oldest", async () => {
      const email = uniqueEmail("login");
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      const t3 = await b.newTenant();
      expect(await b.store.apiAuth.findUserByEmail(email)).toBeNull();
      const old = await addUser(b, t1, { email, createdAt: new Date(Date.UTC(2026, 0, 1)), deactivatedAt: new Date() });
      expect(await b.store.apiAuth.findUserByEmail(email)).toEqual({ id: old, tenantId: t1, email });
      const nullCreated = await addUser(b, t3, { email, createdAt: null });
      const active = await addUser(b, t2, { email, createdAt: new Date(Date.UTC(2026, 0, 2)) });
      expect(await b.store.apiAuth.findUserByEmail(email)).toEqual({ id: active, tenantId: t2, email });
      void nullCreated;
    });

    it("magic link tokens: create, find (not consumed), consume once", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      const u = await addUser(b, t, { email });
      const tokenHash = `h-${randomUUID()}`;
      const expiresAt = new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 9));
      expect(await b.store.apiAuth.findMagicLinkToken(tokenHash)).toBeNull();
      await b.store.apiAuth.createMagicLinkToken({ tenantId: t, userId: u, tokenHash, expiresAt });
      expect(await b.store.apiAuth.findMagicLinkToken(tokenHash)).toEqual({ expiresAt, consumedAt: null, email });

      const now = new Date(Date.UTC(2029, 0, 1));
      const consumed = await b.store.apiAuth.consumeMagicLinkToken({ tokenHash, now });
      expect(consumed).toEqual({ id: expect.any(String), userId: u, tenantId: t, expiresAt });
      expect(await b.store.apiAuth.consumeMagicLinkToken({ tokenHash, now })).toBeNull();
      expect(await b.store.apiAuth.consumeMagicLinkToken({ tokenHash: "unknown", now })).toBeNull();
      expect(await b.store.apiAuth.findMagicLinkToken(tokenHash)).toEqual({ expiresAt, consumedAt: now, email });
    });

    it("consumeMagicLinkToken: concurrent consumers, exactly one wins", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t);
      const tokenHash = `h-${randomUUID()}`;
      await b.store.apiAuth.createMagicLinkToken({ tenantId: t, userId: u, tokenHash, expiresAt: new Date(Date.now() + 60_000) });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => b.store.apiAuth.consumeMagicLinkToken({ tokenHash, now: new Date() })),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("findTenantBrand returns name and parsed settings", async () => {
      const t = await b.newTenant("Brand Co");
      await b.db.update(b.schema.tenants).set({ settings: { brand: { color: "#fff" }, n: null } }).where(eq(b.schema.tenants.id, t));
      expect(await b.store.apiAuth.findTenantBrand(t)).toEqual({ name: "Brand Co", settings: { brand: { color: "#fff" }, n: null } });
      expect(await b.store.apiAuth.findTenantBrand(randomUUID())).toBeNull();
    });

    it("sessions: create, find, delete", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t);
      const expiresAt = new Date(Date.UTC(2030, 1, 1, 0, 0, 0, 1));
      const id = await b.store.apiAuth.createSession({ tenantId: t, userId: u, expiresAt });
      expect(await b.store.apiAuth.findSession(id)).toEqual({ userId: u, tenantId: t, expiresAt });
      await b.store.apiAuth.deleteSession(id);
      expect(await b.store.apiAuth.findSession(id)).toBeNull();
      const other = await addSession(b, t, u);
      await b.store.apiAuth.deleteSession(randomUUID());
      expect(await b.store.apiAuth.findSession(other)).not.toBeNull();
    });

    it("touchUserLastLogin and findUserById", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      const u = await addUser(b, t, { email, name: "Ann", role: "owner" });
      expect(await b.store.apiAuth.findUserById(u)).toEqual({ id: u, email, name: "Ann", role: "owner" });
      expect(await b.store.apiAuth.findUserById(randomUUID())).toBeNull();
      const now = new Date(Date.UTC(2026, 6, 1, 1, 2, 3, 4));
      await b.store.apiAuth.touchUserLastLogin({ userId: u, now });
      const [row] = await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, u));
      expect(row.lastLoginAt).toEqual(now);
    });
  });
}
