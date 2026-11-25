/**
 * Contract tests for the apiProfile store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addTransport, addUser, uniqueEmail } from "./support/identity.js";

for (const factory of testBackends()) {
  describe(`apiProfile on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getProfile, setName, getEmail", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 5));
      const u = await addUser(b, t, { email, role: "owner", createdAt });
      expect(await b.store.apiProfile.getProfile({ userId: u })).toEqual({
        id: u, email, name: null, role: "owner", pendingEmail: null, pendingEmailExpiresAt: null, createdAt,
      });
      await b.store.apiProfile.setName({ userId: u, name: "Ann" });
      expect((await b.store.apiProfile.getProfile({ userId: u }))!.name).toBe("Ann");
      await b.store.apiProfile.setName({ userId: u, name: null });
      expect((await b.store.apiProfile.getProfile({ userId: u }))!.name).toBeNull();
      expect(await b.store.apiProfile.getEmail({ userId: u })).toBe(email);
      expect(await b.store.apiProfile.getEmail({ userId: randomUUID() })).toBeNull();
      expect(await b.store.apiProfile.getProfile({ userId: randomUUID() })).toBeNull();
    });

    it("isEmailTaken is scoped to the tenant", async () => {
      const t = await b.newTenant();
      const email = uniqueEmail();
      await addUser(b, t, { email });
      expect(await b.store.apiProfile.isEmailTaken({ tenantId: t, email })).toBe(true);
      expect(await b.store.apiProfile.isEmailTaken({ tenantId: await b.newTenant(), email })).toBe(false);
    });

    it("pending email change: set, read, clear, apply", async () => {
      const t = await b.newTenant();
      const u = await addUser(b, t);
      expect(await b.store.apiProfile.getPendingEmailChange({ userId: u })).toEqual({
        pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null,
      });
      expect(await b.store.apiProfile.getPendingEmailChange({ userId: randomUUID() })).toBeNull();
      const next = uniqueEmail("new");
      const expiresAt = new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 3));
      await b.store.apiProfile.setPendingEmail({ userId: u, pendingEmail: next, tokenHash: "h1", expiresAt });
      expect(await b.store.apiProfile.getPendingEmailChange({ userId: u })).toEqual({
        pendingEmail: next, pendingEmailTokenHash: "h1", pendingEmailExpiresAt: expiresAt,
      });
      expect(await b.store.apiProfile.getProfile({ userId: u })).toMatchObject({ pendingEmail: next, pendingEmailExpiresAt: expiresAt });
      await b.store.apiProfile.clearPendingEmail({ userId: u });
      expect(await b.store.apiProfile.getPendingEmailChange({ userId: u })).toEqual({
        pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null,
      });
      await b.store.apiProfile.setPendingEmail({ userId: u, pendingEmail: next, tokenHash: "h2", expiresAt });
      await b.store.apiProfile.applyEmailChange({ userId: u, email: next });
      const [row] = await b.db.select().from(b.schema.users).where(eq(b.schema.users.id, u));
      expect(row).toMatchObject({ email: next, pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null });
    });

    it("getTenantBrand and getActiveTransport", async () => {
      const t = await b.newTenant("Prof Co");
      expect(await b.store.apiProfile.getTenantBrand({ tenantId: t })).toEqual({ name: "Prof Co", settings: null });
      expect(await b.store.apiProfile.getTenantBrand({ tenantId: randomUUID() })).toBeNull();
      expect(await b.store.apiProfile.getActiveTransport({ tenantId: t })).toBeNull();
      await addTransport(b, t);
      const tr = await b.store.apiProfile.getActiveTransport({ tenantId: t });
      expect(tr).toMatchObject({ provider: "resend", from_email: "from@example.com", from_name: "From" });
      expect(JSON.parse(tr!.config)).toEqual({ apiKey: "k", nested: { a: 1 } });
    });
  });
}
