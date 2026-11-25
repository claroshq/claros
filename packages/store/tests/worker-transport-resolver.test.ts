/**
 * Contract tests for the workerTransportResolver store area (packages/worker/src/transport-resolver.ts).
 *
 * config is JSON text. Postgres renders jsonb::text (its own whitespace and key order),
 * D1 returns the stored text; the caller parses it, so the contract is the parsed value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`workerTransportResolver on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("getActiveTransportConfig returns the active config with config as JSON text", async () => {
      const t = await b.newTenant();
      const none = await b.newTenant();
      const envelope = { iv: "abc", tag: "def", data: "ghi", v: 1 };
      await b.db.insert(b.schema.transportConfigs).values([
        { tenantId: t, provider: "smtp", config: { old: true }, fromEmail: "old@x.com", isActive: false },
        { tenantId: t, provider: "resend", config: envelope, fromEmail: "hi@x.com", fromName: "Acme" },
        { tenantId: none, provider: "resend", config: envelope, fromEmail: "a@x.com", isActive: false },
      ]);
      const row = await b.store.workerTransportResolver.getActiveTransportConfig(t);
      expect(row).not.toBeNull();
      expect(typeof row!.config).toBe("string");
      expect({ ...row!, config: JSON.parse(row!.config) }).toEqual({
        provider: "resend",
        config: envelope,
        from_email: "hi@x.com",
        from_name: "Acme",
      });
      expect(await b.store.workerTransportResolver.getActiveTransportConfig(none)).toBeNull();
    });
  });
}
