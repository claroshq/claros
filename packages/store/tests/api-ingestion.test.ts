/**
 * Contract tests for the apiIngestion and apiIngestAuth store areas (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`apiIngestion / apiIngestAuth on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const newKey = (tenantId: string, extra: Partial<{ kind: string; label: string | null; allowedOrigins: string[] | null }> = {}) => ({
      tenantId,
      keyHash: `kh-${randomUUID()}`,
      prefix: "cl_test_",
      label: null,
      kind: "secret",
      allowedOrigins: null,
      ...extra,
    });

    it("createKey returns the display row; listKeys lists the tenant's keys oldest first, NULL created_at last", async () => {
      const t = await b.newTenant();
      const created = await b.store.apiIngestion.createKey(newKey(t, { kind: "publishable", label: "Web", allowedOrigins: ["https://a.example"] }));
      expect(created).toEqual({
        id: expect.any(String),
        kind: "publishable",
        prefix: "cl_test_",
        label: "Web",
        allowedOrigins: ["https://a.example"],
        lastUsedAt: null,
        createdAt: expect.any(Date),
        revokedAt: null,
      });
      const old = await b.store.apiIngestion.createKey(newKey(t));
      const nul = await b.store.apiIngestion.createKey(newKey(t));
      await b.db.update(b.schema.apiKeys).set({ createdAt: new Date(Date.UTC(2020, 0, 1)) }).where(eq(b.schema.apiKeys.id, old!.id));
      await b.db.update(b.schema.apiKeys).set({ createdAt: null }).where(eq(b.schema.apiKeys.id, nul!.id));
      await b.store.apiIngestion.createKey(newKey(await b.newTenant()));
      const rows = await b.store.apiIngestion.listKeys(t);
      expect(rows.map((r) => r.id)).toEqual([old!.id, created!.id, nul!.id]);
    });

    it("findKeyKind / findKeyRevocation are tenant scoped; updateKey and revokeKey", async () => {
      const t = await b.newTenant();
      const k = (await b.store.apiIngestion.createKey(newKey(t, { kind: "publishable" })))!;
      const other = await b.newTenant();
      expect(await b.store.apiIngestion.findKeyKind(t, k.id)).toEqual({ id: k.id, kind: "publishable" });
      expect(await b.store.apiIngestion.findKeyKind(other, k.id)).toBeNull();
      expect(await b.store.apiIngestion.findKeyRevocation(t, k.id)).toEqual({ id: k.id, revokedAt: null });
      expect(await b.store.apiIngestion.findKeyRevocation(other, k.id)).toBeNull();

      const updated = await b.store.apiIngestion.updateKey(k.id, { label: "Renamed", allowedOrigins: ["https://b.example"] });
      expect(updated).toMatchObject({ id: k.id, label: "Renamed", allowedOrigins: ["https://b.example"] });
      const partial = await b.store.apiIngestion.updateKey(k.id, { label: null, allowedOrigins: undefined });
      expect(partial).toMatchObject({ label: null, allowedOrigins: ["https://b.example"] });
      expect(await b.store.apiIngestion.updateKey(randomUUID(), { label: "x" })).toBeUndefined();

      const at = new Date(Date.UTC(2026, 1, 2, 3, 4, 5, 6));
      await b.store.apiIngestion.revokeKey(k.id, at);
      expect(await b.store.apiIngestion.findKeyRevocation(t, k.id)).toEqual({ id: k.id, revokedAt: at });
    });

    it("findLastEventSince / countEventsSince", async () => {
      const t = await b.newTenant();
      const contactId = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id: contactId, tenantId: t, externalId: "ext-1", lifecycleState: "signed_up" });
      // Near now: the Postgres events table only has partitions around the current month.
      const base = Date.now() - 60 * 60_000;
      const at = (m: number) => new Date(base + m * 60_000);
      const ev = (receivedAt: Date, type = "track", eventName: string | null = "e") =>
        b.db.insert(b.schema.events).values({ tenantId: t, contactId, type, eventName, timestamp: receivedAt, receivedAt });
      await ev(at(0), "track", "before");
      await ev(at(10), "identify", null);
      await ev(at(20), "track", "latest");
      await ev(at(5), "track", "middle");
      expect(await b.store.apiIngestion.findLastEventSince(t, at(1))).toEqual({
        type: "track", eventName: "latest", receivedAt: at(20), externalId: "ext-1",
      });
      expect(await b.store.apiIngestion.findLastEventSince(t, at(21))).toBeNull();
      expect(await b.store.apiIngestion.countEventsSince(t, at(5))).toBe(3);
      expect(await b.store.apiIngestion.countEventsSince(t, at(0))).toBe(4);
      expect(await b.store.apiIngestion.countEventsSince(t, at(21))).toBe(0);
    });

    it("findActiveKeyByHash matches active ingestion keys only; touchKeyLastUsed", async () => {
      const t = await b.newTenant();
      const secret = newKey(t, { kind: "secret" });
      const pub = newKey(t, { kind: "publishable", allowedOrigins: ["https://a.example"] });
      const admin = newKey(t, { kind: "admin" });
      const revoked = newKey(t);
      const s = (await b.store.apiIngestion.createKey(secret))!;
      const p = (await b.store.apiIngestion.createKey(pub))!;
      await b.store.apiIngestion.createKey(admin);
      const r = (await b.store.apiIngestion.createKey(revoked))!;
      await b.store.apiIngestion.revokeKey(r.id, new Date());
      const instanceHash = `kh-${randomUUID()}`;
      await b.db.insert(b.schema.apiKeys).values({ tenantId: null, keyHash: instanceHash, prefix: "cl_inst_", kind: "instance" });

      expect(await b.store.apiIngestAuth.findActiveKeyByHash(secret.keyHash)).toEqual({ id: s.id, tenantId: t, kind: "secret", allowedOrigins: null });
      expect(await b.store.apiIngestAuth.findActiveKeyByHash(pub.keyHash)).toEqual({
        id: p.id, tenantId: t, kind: "publishable", allowedOrigins: ["https://a.example"],
      });
      expect(await b.store.apiIngestAuth.findActiveKeyByHash(admin.keyHash)).toBeNull();
      expect(await b.store.apiIngestAuth.findActiveKeyByHash(revoked.keyHash)).toBeNull();
      expect(await b.store.apiIngestAuth.findActiveKeyByHash(instanceHash)).toBeNull();
      expect(await b.store.apiIngestAuth.findActiveKeyByHash("unknown")).toBeNull();

      const at = new Date(Date.UTC(2026, 3, 3, 3, 3, 3, 3));
      await b.store.apiIngestAuth.touchKeyLastUsed(s.id, at);
      expect((await b.store.apiIngestion.listKeys(t)).find((k) => k.id === s.id)!.lastUsedAt).toEqual(at);
    });
  });
}
