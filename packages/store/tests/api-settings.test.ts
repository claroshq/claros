/**
 * Contract tests for apiSettings (packages/api/src/routes/settings.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

const ENVELOPE = JSON.stringify({ v: 1, iv: "abc", tag: "def", data: "ghi" });

for (const factory of testBackends()) {
  describe(`apiSettings on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const s = () => b.store.apiSettings;

    async function transportRows(tenantId: string) {
      const t = b.schema.transportConfigs;
      return b.db.select().from(t).where(eq(t.tenantId, tenantId));
    }

    it("inserts, finds and deactivates transport configs", async () => {
      const t = await b.newTenant();
      expect(await s().findActiveTransportConfig(t)).toBeNull();
      expect(await s().findActiveTransportForSend(t)).toBeNull();

      const first = await s().insertActiveTransportConfig({
        tenantId: t, provider: "resend", encryptedConfig: ENVELOPE, fromEmail: "a@x.io", fromName: "A", dailyLimit: 100,
      });
      expect(first).toMatchObject({
        provider: "resend", fromEmail: "a@x.io", fromName: "A", dailyLimit: 100, dkimVerified: false, isActive: true,
      });
      expect(Object.keys(first!).sort()).toEqual(
        ["createdAt", "dailyLimit", "dkimVerified", "fromEmail", "fromName", "id", "isActive", "provider"],
      );
      expect(first!.createdAt).toBeInstanceOf(Date);
      expect(await s().findActiveTransportConfig(t)).toEqual(first);

      // The envelope is stored as JSON.
      expect((await transportRows(t))[0].config).toEqual(JSON.parse(ENVELOPE));

      const send = await s().findActiveTransportForSend(t);
      expect(send).toMatchObject({ provider: "resend", from_email: "a@x.io", from_name: "A" });
      expect(typeof send!.config).toBe("string");
      expect(JSON.parse(send!.config)).toEqual(JSON.parse(ENVELOPE));

      await s().deactivateActiveTransportConfigs(t);
      expect(await s().findActiveTransportConfig(t)).toBeNull();
      expect(await s().findActiveTransportForSend(t)).toBeNull();
      expect((await transportRows(t)).map((r: { isActive: boolean }) => r.isActive)).toEqual([false]);

      const second = await s().insertActiveTransportConfig({
        tenantId: t, provider: "smtp", encryptedConfig: ENVELOPE, fromEmail: "b@x.io", fromName: null, dailyLimit: null,
      });
      expect(second).toMatchObject({ provider: "smtp", fromName: null, dailyLimit: null, isActive: true });
      expect((await s().findActiveTransportConfig(t))!.id).toBe(second!.id);
    });

    it("deactivates only the tenant's own transport configs", async () => {
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      for (const t of [t1, t2]) {
        await s().insertActiveTransportConfig({
          tenantId: t, provider: "resend", encryptedConfig: ENVELOPE, fromEmail: "a@x.io", fromName: null, dailyLimit: null,
        });
      }
      await s().deactivateActiveTransportConfigs(t1);
      expect(await s().findActiveTransportConfig(t1)).toBeNull();
      expect(await s().findActiveTransportConfig(t2)).not.toBeNull();
    });

    it("inserts, finds and deactivates LLM configs", async () => {
      const t = await b.newTenant();
      expect(await s().findActiveLlmConfig(t)).toBeNull();
      const inserted = await s().insertActiveLlmConfig({ tenantId: t, provider: "openai", encryptedConfig: ENVELOPE });
      expect(inserted).toMatchObject({ provider: "openai", isActive: true });
      expect(Object.keys(inserted!).sort()).toEqual(["createdAt", "id", "isActive", "provider"]);
      expect(inserted!.createdAt).toBeInstanceOf(Date);

      expect(await s().findActiveLlmConfig(t)).toEqual({ ...inserted, config: ENVELOPE });

      const other = await b.newTenant();
      await s().insertActiveLlmConfig({ tenantId: other, provider: "anthropic", encryptedConfig: ENVELOPE });
      await s().deactivateActiveLlmConfigs(t);
      expect(await s().findActiveLlmConfig(t)).toBeNull();
      expect(await s().findActiveLlmConfig(other)).not.toBeNull();
      const l = b.schema.llmConfigs;
      const rows = await b.db.select().from(l).where(and(eq(l.tenantId, t), eq(l.isActive, false)));
      expect(rows).toHaveLength(1);
    });

    it("reads and writes tenant settings", async () => {
      const t = await b.newTenant("Acme");
      const tenant = await s().findTenant(t);
      expect(tenant).toMatchObject({ id: t, name: "Acme", plan: "free", settings: null });
      expect(tenant!.slug).toMatch(/^t-/);
      expect(tenant!.createdAt).toBeInstanceOf(Date);
      expect(await s().findTenantSettings(t)).toEqual({ settings: null });
      expect(await s().findTenantNameAndSettings(t)).toEqual({ name: "Acme", settings: null });

      const settings = { lifecycle: { activation_events: ["a"] }, throttle: { perDay: 2 }, flag: false, none: null };
      await s().updateTenantSettings(t, settings);
      expect(await s().findTenantSettings(t)).toEqual({ settings });
      expect(await s().findTenantNameAndSettings(t)).toEqual({ name: "Acme", settings });
      expect((await s().findTenant(t))!.settings).toEqual(settings);

      const missing = "00000000-0000-4000-8000-000000000000";
      expect(await s().findTenant(missing)).toBeNull();
      expect(await s().findTenantSettings(missing)).toBeNull();
      expect(await s().findTenantNameAndSettings(missing)).toBeNull();
    });
  });
}
