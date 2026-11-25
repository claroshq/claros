/**
 * brand.layout on Postgres: the settings API accepts "narrow" and "wide",
 * rejects anything else and clears with null; config as code exports it,
 * applies it, reports the diff and refuses other values.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, newProduct, newKey, app as buildTestApp, dropProduct, bearer, cookieJson, type TestDb, type TestProduct } from "./support/product.js";
import type { ClarosApp } from "../src/app.js";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
const products: TestProduct[] = [];

async function product(label: string): Promise<TestProduct> {
  const p = await newProduct(db, label);
  products.push(p);
  return p;
}

const patchBrand = (p: TestProduct, brand: Record<string, unknown>) =>
  a.inject({ method: "PATCH", url: "/v1/settings/tenant", headers: cookieJson(p.ownerCookie), payload: { brand } });
const getTenant = async (p: TestProduct) =>
  (await a.inject({ method: "GET", url: "/v1/settings/tenant", headers: { cookie: p.ownerCookie } })).json().tenant;

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("PATCH /v1/settings/tenant brand.layout", () => {
  it("is null (the narrow default) until set", async () => {
    const p = await product("layout-default");
    expect((await getTenant(p)).brand.layout).toBeNull();
  });

  it("accepts wide and narrow, returns and stores them, and null clears", async () => {
    const p = await product("layout-set");
    const wide = await patchBrand(p, { brand_name: "Acme", layout: "wide" });
    expect(wide.statusCode).toBe(200);
    expect(wide.json().tenant.brand).toMatchObject({ brand_name: "Acme", layout: "wide" });
    expect((await getTenant(p)).brand.layout).toBe("wide");

    expect((await patchBrand(p, { layout: "narrow" })).json().tenant.brand.layout).toBe("narrow");

    const cleared = await patchBrand(p, { layout: null });
    expect(cleared.json().tenant.brand).toMatchObject({ brand_name: "Acme", layout: null });
  });

  it("rejects other values with 400 and keeps the stored layout", async () => {
    const p = await product("layout-bad");
    await patchBrand(p, { layout: "wide" });
    for (const layout of ["full", "WIDE", ""]) {
      const res = await patchBrand(p, { layout });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/brand\.layout/);
    }
    expect((await patchBrand(p, { layout: 2 })).statusCode).toBe(400);
    expect((await getTenant(p)).brand.layout).toBe("wide");
  });

  it("is owner-only like the other brand fields", async () => {
    const p = await product("layout-role");
    const res = await a.inject({ method: "PATCH", url: "/v1/settings/tenant", headers: cookieJson(p.memberCookie), payload: { brand: { layout: "wide" } } });
    expect(res.statusCode).toBe(403);
  });
});

describe("config as code: settings.brand.layout", () => {
  it("exports the layout, applies a change with a diff, and applying the export again changes nothing", async () => {
    const p = await product("layout-config");
    await patchBrand(p, { brand_name: "Acme", layout: "wide" });
    const auth = bearer(await newKey(db, p.tenantId, "admin", ["config"]));

    const doc = (await a.inject({ method: "GET", url: "/v1/config", headers: auth })).json();
    expect(doc.settings.brand).toEqual({ brand_name: "Acme", layout: "wide" });
    expect((await a.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: doc })).json().changes).toEqual([]);

    const next = { ...doc, settings: { ...doc.settings, brand: { brand_name: "Acme", layout: "narrow" } } };
    const dry = (await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: auth, payload: next })).json();
    expect(dry.changes).toEqual([{ kind: "setting", key: "brand", action: "update" }]);
    expect((await getTenant(p)).brand.layout).toBe("wide");

    const applied = await a.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: next });
    expect(applied.statusCode).toBe(200);
    expect((await getTenant(p)).brand.layout).toBe("narrow");
  });

  it("refuses other layout values", async () => {
    const p = await product("layout-config-bad");
    const auth = bearer(await newKey(db, p.tenantId, "admin", ["config"]));
    const res = await a.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: { settings: { brand: { layout: "full" } } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("settings.brand.layout");
  });
});
