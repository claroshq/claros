/**
 * Contract tests for the apiBrand store area (every backend): the uploaded
 * logo round-trips byte for byte, save and delete change settings in the
 * same unit, and products resolve by id, public host and slug.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

for (const backend of testBackends()) {
  describe(`apiBrand (${backend.name})`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await backend.open();
    }, 60_000);
    afterAll(async () => {
      await b?.close();
    });

    const settingsOf = async (tenantId: string) =>
      (await b.db.select({ s: b.schema.tenants.settings }).from(b.schema.tenants).where(eq(b.schema.tenants.id, tenantId)))[0]?.s;

    it("finds a product by id, public host and slug", async () => {
      const id = randomUUID();
      const host = `logo-${id.slice(0, 8)}.example.com`;
      await b.db.insert(b.schema.tenants).values({ id, name: "P", slug: `p-${id.slice(0, 8)}`, publicHost: host, settings: { brand: { brand_name: "P" } } });
      const want = { id, slug: `p-${id.slice(0, 8)}`, publicHost: host, settings: { brand: { brand_name: "P" } } };
      expect(await b.store.apiBrand.findProduct(id)).toEqual(want);
      expect(await b.store.apiBrand.findProductByPublicHost(host)).toEqual(want);
      expect(await b.store.apiBrand.findProductBySlug(want.slug)).toEqual(want);
      expect(await b.store.apiBrand.findProduct(randomUUID())).toBeNull();
      expect(await b.store.apiBrand.findProductByPublicHost("nobody.example.com")).toBeNull();
      expect(await b.store.apiBrand.findProductBySlug("no-such-slug")).toBeNull();
    });

    it("saves, replaces and reads the logo byte for byte with the settings in one unit", async () => {
      const t = await b.newTenant();
      expect(await b.store.apiBrand.getLogo(t)).toBeNull();

      const first = { contentType: "image/png", bytes: bytes(1000), width: 200, height: 50, sha256: "a".repeat(64) };
      const now = new Date("2026-11-25T10:00:00.000Z");
      await b.store.apiBrand.saveLogo({ tenantId: t, logo: first, settings: { brand: { logo_url: "https://x/1" } }, now });
      const got = await b.store.apiBrand.getLogo(t);
      expect(got).not.toBeNull();
      expect(got!.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(got!.bytes)).toEqual(Array.from(first.bytes));
      expect({ ...got!, bytes: undefined }).toEqual({ ...first, bytes: undefined, updatedAt: now });
      expect(await settingsOf(t)).toEqual({ brand: { logo_url: "https://x/1" } });

      // A full 256 KB image fits on both backends.
      const big = { contentType: "image/jpeg", bytes: bytes(256 * 1024, 3), width: 640, height: 480, sha256: "b".repeat(64) };
      const later = new Date("2026-11-25T11:00:00.000Z");
      await b.store.apiBrand.saveLogo({ tenantId: t, logo: big, settings: { brand: { logo_url: "https://x/2" } }, now: later });
      const replaced = await b.store.apiBrand.getLogo(t);
      expect(replaced!.bytes.byteLength).toBe(256 * 1024);
      expect(Array.from(replaced!.bytes.subarray(0, 64))).toEqual(Array.from(big.bytes.subarray(0, 64)));
      expect(replaced!.contentType).toBe("image/jpeg");
      expect(replaced!.sha256).toBe(big.sha256);
      expect(replaced!.updatedAt).toEqual(later);
      expect(await settingsOf(t)).toEqual({ brand: { logo_url: "https://x/2" } });
    });

    it("keeps products apart", async () => {
      const a = await b.newTenant();
      const other = await b.newTenant();
      await b.store.apiBrand.saveLogo({
        tenantId: a,
        logo: { contentType: "image/png", bytes: bytes(10), width: 1, height: 1, sha256: "c".repeat(64) },
        settings: {},
        now: new Date(),
      });
      expect(await b.store.apiBrand.getLogo(other)).toBeNull();
      expect(await b.store.apiBrand.deleteLogo({ tenantId: other })).toBe(false);
      expect(await b.store.apiBrand.getLogo(a)).not.toBeNull();
    });

    it("deletes the logo, with or without a settings change", async () => {
      const t = await b.newTenant();
      const logo = { contentType: "image/png", bytes: bytes(10), width: 1, height: 1, sha256: "d".repeat(64) };
      await b.store.apiBrand.saveLogo({ tenantId: t, logo, settings: { brand: { logo_url: "u" } }, now: new Date() });

      expect(await b.store.apiBrand.deleteLogo({ tenantId: t, settings: { brand: {} } })).toBe(true);
      expect(await b.store.apiBrand.getLogo(t)).toBeNull();
      expect(await settingsOf(t)).toEqual({ brand: {} });

      await b.store.apiBrand.saveLogo({ tenantId: t, logo, settings: { brand: { logo_url: "external" } }, now: new Date() });
      expect(await b.store.apiBrand.deleteLogo({ tenantId: t })).toBe(true);
      expect(await settingsOf(t)).toEqual({ brand: { logo_url: "external" } });
      expect(await b.store.apiBrand.deleteLogo({ tenantId: t })).toBe(false);
    });

    it("keeps the logo and its dark-mode version apart", async () => {
      const t = await b.newTenant();
      const light = { contentType: "image/png", bytes: bytes(12, 1), width: 2, height: 1, sha256: "e".repeat(64) };
      const dark = { contentType: "image/png", bytes: bytes(14, 2), width: 2, height: 1, sha256: "f".repeat(64) };
      await b.store.apiBrand.saveLogo({ tenantId: t, logo: light, settings: { brand: { logo_url: "l" } }, now: new Date() });
      await b.store.apiBrand.saveLogo({ tenantId: t, kind: "logo_dark", logo: dark, settings: { brand: { logo_url: "l", logo_dark_url: "d" } }, now: new Date() });

      expect((await b.store.apiBrand.getLogo(t))?.sha256).toBe(light.sha256);
      expect(Array.from((await b.store.apiBrand.getLogo(t, "logo_dark"))!.bytes)).toEqual(Array.from(dark.bytes));

      expect(await b.store.apiBrand.deleteLogo({ tenantId: t, kind: "logo_dark", settings: { brand: { logo_url: "l" } } })).toBe(true);
      expect(await b.store.apiBrand.getLogo(t, "logo_dark")).toBeNull();
      expect((await b.store.apiBrand.getLogo(t))?.sha256).toBe(light.sha256);
      expect(await settingsOf(t)).toEqual({ brand: { logo_url: "l" } });
    });
  });
}
