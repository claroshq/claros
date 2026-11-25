/**
 * Contract tests for the apiAdminAuth store area (G1) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`apiAdminAuth on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const key = (tenantId: string, kind: string, scopes: string[] | null) => ({
      tenantId,
      keyHash: `kh-${randomUUID()}`,
      prefix: "clr_ak_x",
      label: null,
      kind,
      allowedOrigins: null,
      scopes,
    });

    it("finds an active admin key with its product and scopes; createKey stores scopes", async () => {
      const t = await b.newTenant();
      const k = key(t, "admin", ["messages", "suppressions"]);
      const created = await b.store.apiIngestion.createKey(k);
      expect(created!.scopes).toEqual(["messages", "suppressions"]);
      const row = await b.store.apiAdminAuth.findActiveAdminKeyByHash(k.keyHash);
      expect(row).toEqual({
        id: created!.id,
        tenantId: t,
        tenantSlug: expect.stringMatching(/^t-/),
        tenantArchivedAt: null,
        scopes: ["messages", "suppressions"],
      });
      const updated = await b.store.apiIngestion.updateKey(created!.id, { scopes: ["config"] });
      expect(updated!.scopes).toEqual(["config"]);
    });

    it("never matches ingestion keys, revoked keys or unknown hashes", async () => {
      const t = await b.newTenant();
      const secret = key(t, "secret", null);
      await b.store.apiIngestion.createKey(secret);
      expect(await b.store.apiAdminAuth.findActiveAdminKeyByHash(secret.keyHash)).toBeNull();
      const admin = key(t, "admin", ["kb"]);
      const created = await b.store.apiIngestion.createKey(admin);
      await b.store.apiIngestion.revokeKey(created!.id, new Date());
      expect(await b.store.apiAdminAuth.findActiveAdminKeyByHash(admin.keyHash)).toBeNull();
      expect(await b.store.apiAdminAuth.findActiveAdminKeyByHash("nope")).toBeNull();
      // Admin keys never authenticate ingestion.
      const admin2 = key(t, "admin", ["kb"]);
      await b.store.apiIngestion.createKey(admin2);
      expect(await b.store.apiIngestAuth.findActiveKeyByHash(admin2.keyHash)).toBeNull();
    });

    it("reports the product's archived state", async () => {
      const t = await b.newTenant();
      const admin = key(t, "admin", ["config"]);
      await b.store.apiIngestion.createKey(admin);
      await b.db.update(b.schema.tenants).set({ archivedAt: new Date(Date.UTC(2026, 0, 1)) }).where(eq(b.schema.tenants.id, t));
      const row = await b.store.apiAdminAuth.findActiveAdminKeyByHash(admin.keyHash);
      expect(row!.tenantArchivedAt).toEqual(new Date(Date.UTC(2026, 0, 1)));
    });
  });
}
