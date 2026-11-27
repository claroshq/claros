/**
 * Uploaded brand logo on Postgres: upload rules (types, size, roles and
 * admin keys), brand settings written on upload and delete, public serving
 * with cache headers, the public-host rule, and config-as-code export.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { tenants } from "@claros/db/schema";
import { openDb, newProduct, newKey, app as buildTestApp, dropProduct, type TestDb, type TestProduct } from "./support/product.js";
import { LOGO_JPEG, LOGO_PNG, SVG } from "./support/logo.js";
import type { ClarosApp } from "../src/app.js";

const BASE = "http://localhost:3000";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
const products: TestProduct[] = [];

async function product(label: string): Promise<TestProduct> {
  const p = await newProduct(db, label);
  products.push(p);
  return p;
}

function upload(auth: Record<string, string>, body: Uint8Array | string, type: string | null, url = `${BASE}/v1/settings/brand/logo`) {
  const headers = new Headers(auth);
  if (type) headers.set("content-type", type);
  return a.fetch(new Request(url, { method: "POST", headers, body }));
}

const get = (url: string, headers: Record<string, string> = {}) => a.fetch(new Request(url, { headers }));
const del = (auth: Record<string, string>) => a.fetch(new Request(`${BASE}/v1/settings/brand/logo`, { method: "DELETE", headers: auth }));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cookie = (c: string) => ({ cookie: c });

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("POST /v1/settings/brand/logo", () => {
  it("stores a PNG, points brand.logo_url at the hosted URL and defaults logo_height", async () => {
    const p = await product("logo-up");
    const res = await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png");
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const url = `${BASE}/brand/${p.slug}/logo?v=${sha(LOGO_PNG).slice(0, 12)}`;
    expect(body.logo).toMatchObject({ url, content_type: "image/png", width: 120, height: 30, size: LOGO_PNG.byteLength, sha256: sha(LOGO_PNG), in_use: true });
    expect(body.brand.logo_url).toBe(url);
    expect(body.brand.logo_height).toBe(30);

    const tenant = (await (await get(`${BASE}/v1/settings/tenant`, cookie(p.ownerCookie))).json()) as any;
    expect(tenant.tenant.brand.logo_url).toBe(url);

    const meta = (await (await get(`${BASE}/v1/settings/brand/logo`, cookie(p.memberCookie))).json()) as any;
    expect(meta.logo.url).toBe(url);
  });

  it("keeps a logo_height that is already set", async () => {
    const p = await product("logo-height");
    await db.update(tenants).set({ settings: { brand: { logo_height: 20, brand_name: "Keep" } } }).where(eq(tenants.id, p.tenantId));
    const body = (await (await upload(cookie(p.ownerCookie), LOGO_JPEG, "image/jpeg")).json()) as any;
    expect(body.brand).toMatchObject({ logo_height: 20, brand_name: "Keep" });
    expect(body.logo).toMatchObject({ content_type: "image/jpeg", width: 120, height: 30 });
  });

  it("answers 415 for SVG, other types and bytes that do not match the declared type", async () => {
    const p = await product("logo-415");
    const c = cookie(p.ownerCookie);
    expect((await upload(c, SVG, "image/svg+xml")).status).toBe(415);
    expect((await upload(c, SVG, "image/png")).status).toBe(415);
    expect((await upload(c, LOGO_PNG, "image/jpeg")).status).toBe(415);
    expect((await upload(c, new TextEncoder().encode("GIF89a\x01\x00\x01\x00"), "image/gif")).status).toBe(415);
    expect((await upload(c, "{}", "application/json")).status).toBe(415);
    expect((await upload(c, LOGO_PNG, "application/octet-stream")).status).toBe(415);
    expect((await get(`${BASE}/v1/settings/brand/logo`, c).then((r) => r.json()) as any).logo).toBeNull();
  });

  it("answers 413 above 256 KB", async () => {
    const p = await product("logo-413");
    const big = new Uint8Array(256 * 1024 + 1);
    big.set(LOGO_PNG);
    const res = await upload(cookie(p.ownerCookie), big, "image/png");
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toContain("256 KB");
    // Exactly 256 KB is accepted.
    expect((await upload(cookie(p.ownerCookie), big.subarray(0, 256 * 1024), "image/png")).status).toBe(201);
  });

  it("needs an owner or an admin key with the config scope", async () => {
    const p = await product("logo-auth");
    expect((await upload({}, LOGO_PNG, "image/png")).status).toBe(401);
    expect((await upload(cookie(p.memberCookie), LOGO_PNG, "image/png")).status).toBe(403);
    const other = await newKey(db, p.tenantId, "admin", ["kb"]);
    expect((await upload({ authorization: `Bearer ${other}` }, LOGO_PNG, "image/png")).status).toBe(403);
    const key = await newKey(db, p.tenantId, "admin", ["config"]);
    expect((await upload({ authorization: `Bearer ${key}` }, LOGO_PNG, "image/png")).status).toBe(201);
    expect((await del(cookie(p.memberCookie))).status).toBe(403);
    expect((await del({ authorization: `Bearer ${key}` })).status).toBe(200);
  });
});

describe("GET /brand/:slug/logo", () => {
  it("serves the bytes with the right type and cache headers, for any v", async () => {
    const p = await product("logo-serve");
    const { logo } = (await (await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png")).json()) as any;

    const res = await get(logo.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LOGO_PNG);

    const bare = await get(`${BASE}/brand/${p.slug}/logo`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get("cache-control")).toBe("public, max-age=300");

    const etag = res.headers.get("etag")!;
    expect((await get(logo.url, { "if-none-match": etag })).status).toBe(304);

    // A new upload: the old URL (mail already sent) serves the current logo, briefly cached.
    const next = (await (await upload(cookie(p.ownerCookie), LOGO_JPEG, "image/jpeg")).json()) as any;
    expect(next.logo.url).not.toBe(logo.url);
    const old = await get(logo.url);
    expect(old.status).toBe(200);
    expect(old.headers.get("content-type")).toBe("image/jpeg");
    expect(old.headers.get("cache-control")).toBe("public, max-age=300");
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(LOGO_JPEG);
  });

  it("is 404 for a product without a logo and for an unknown slug", async () => {
    const p = await product("logo-none");
    expect((await get(`${BASE}/brand/${p.slug}/logo`)).status).toBe(404);
    expect((await get(`${BASE}/brand/no-such-product-slug/logo`)).status).toBe(404);
    expect((await get(`${BASE}/brand/logo`)).status).toBe(404);
  });

  it("on a public host serves only that product", async () => {
    const hosted = await product("logo-host");
    const other = await product("logo-other");
    const host = `logo-${hosted.slug}.example.com`;
    await db.update(tenants).set({ publicHost: host }).where(eq(tenants.id, hosted.tenantId));
    const { logo } = (await (await upload(cookie(hosted.ownerCookie), LOGO_PNG, "image/png")).json()) as any;
    await upload(cookie(other.ownerCookie), LOGO_JPEG, "image/jpeg");

    expect(logo.url).toBe(`https://${host}/brand/logo?v=${sha(LOGO_PNG).slice(0, 12)}`);
    const own = await get(logo.url);
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(LOGO_PNG);
    expect((await get(`https://${host}/brand/${hosted.slug}/logo`)).status).toBe(200);
    expect((await get(`https://${host}/brand/${other.slug}/logo`)).status).toBe(404);

    // The instance host serves every product by slug, including one with a public host.
    expect((await get(`${BASE}/brand/${hosted.slug}/logo`)).status).toBe(200);
    expect((await get(`${BASE}/brand/${other.slug}/logo`)).status).toBe(200);
  });
});

describe("DELETE /v1/settings/brand/logo", () => {
  it("removes the logo and clears brand.logo_url when it pointed at the upload", async () => {
    const p = await product("logo-del");
    const { logo } = (await (await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png")).json()) as any;
    const res = await del(cookie(p.ownerCookie));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).brand.logo_url).toBeNull();
    expect((await get(logo.url)).status).toBe(404);
    expect((await del(cookie(p.ownerCookie))).status).toBe(404);
  });

  it("leaves an external brand.logo_url alone", async () => {
    const p = await product("logo-ext");
    await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png");
    await a.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: p.ownerCookie, "content-type": "application/json" },
      payload: { brand: { logo_url: "https://cdn.example.com/logo.png" } },
    });
    const meta = (await (await get(`${BASE}/v1/settings/brand/logo`, cookie(p.ownerCookie))).json()) as any;
    expect(meta.logo.in_use).toBe(false);
    const body = (await (await del(cookie(p.ownerCookie))).json()) as any;
    expect(body.brand.logo_url).toBe("https://cdn.example.com/logo.png");
  });
});

describe("config as code", () => {
  it("exports the hosted logo URL, and applying the export again changes nothing", async () => {
    const p = await product("logo-config");
    const { logo } = (await (await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png")).json()) as any;
    const key = await newKey(db, p.tenantId, "admin", ["config"]);
    const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const doc = (await a.inject({ method: "GET", url: "/v1/config", headers: auth })).json();
    expect(doc.settings.brand.logo_url).toBe(logo.url);
    const again = (await a.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: doc })).json();
    expect(again.changes).toEqual([]);
  });
});

describe("dark-mode logo (/v1/settings/brand/logo-dark)", () => {
  const darkUrl = `${BASE}/v1/settings/brand/logo-dark`;
  const delDark = (auth: Record<string, string>) => a.fetch(new Request(darkUrl, { method: "DELETE", headers: auth }));

  it("stores it next to the logo, sets brand.logo_dark_url and leaves logo_height alone", async () => {
    const p = await product("logo-dark");
    const c = cookie(p.ownerCookie);
    const light = (await (await upload(c, LOGO_PNG, "image/png")).json()) as any;
    const res = await upload(c, LOGO_JPEG, "image/jpeg", darkUrl);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const url = `${BASE}/brand/${p.slug}/logo-dark?v=${sha(LOGO_JPEG).slice(0, 12)}`;
    expect(body.logo).toMatchObject({ url, content_type: "image/jpeg", in_use: true });
    expect(body.brand).toMatchObject({ logo_url: light.logo.url, logo_dark_url: url, logo_height: 30 });

    const tenant = (await (await get(`${BASE}/v1/settings/tenant`, c)).json()) as any;
    expect(tenant.tenant.brand.logo_dark_url).toBe(url);
    expect(((await (await get(darkUrl, cookie(p.memberCookie))).json()) as any).logo.url).toBe(url);

    // Served publicly, apart from the logo.
    const served = await get(url);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(LOGO_JPEG);
    expect(new Uint8Array(await (await get(light.logo.url)).arrayBuffer())).toEqual(LOGO_PNG);
  });

  it("deletes only the dark-mode logo and clears brand.logo_dark_url", async () => {
    const p = await product("logo-dark-del");
    const c = cookie(p.ownerCookie);
    await upload(c, LOGO_PNG, "image/png");
    const dark = (await (await upload(c, LOGO_PNG, "image/png", darkUrl)).json()) as any;
    expect((await delDark(cookie(p.memberCookie))).status).toBe(403);
    const res = await delDark(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.brand.logo_dark_url).toBeNull();
    expect(body.brand.logo_url).not.toBeNull();
    expect((await get(dark.logo.url)).status).toBe(404);
    expect((await get(`${BASE}/brand/${p.slug}/logo`)).status).toBe(200);
    expect((await delDark(c)).status).toBe(404);
  });

  it("applies the same upload rules", async () => {
    const p = await product("logo-dark-rules");
    expect((await upload(cookie(p.ownerCookie), SVG, "image/svg+xml", darkUrl)).status).toBe(415);
    expect((await upload(cookie(p.memberCookie), LOGO_PNG, "image/png", darkUrl)).status).toBe(403);
  });

  it("is served on a product's public host", async () => {
    const p = await product("logo-dark-host");
    const host = `dark-${p.slug}.example.com`;
    await db.update(tenants).set({ publicHost: host }).where(eq(tenants.id, p.tenantId));
    const { logo } = (await (await upload(cookie(p.ownerCookie), LOGO_PNG, "image/png", darkUrl)).json()) as any;
    expect(logo.url).toBe(`https://${host}/brand/logo-dark?v=${sha(LOGO_PNG).slice(0, 12)}`);
    expect((await get(logo.url)).status).toBe(200);
  });

  it("PATCH /v1/settings/tenant accepts an external logo_dark_url and refuses a non-URL", async () => {
    const p = await product("logo-dark-patch");
    const patch = (brand: Record<string, unknown>) =>
      a.inject({ method: "PATCH", url: "/v1/settings/tenant", headers: { cookie: p.ownerCookie, "content-type": "application/json" }, payload: { brand } });
    expect((await patch({ logo_dark_url: "javascript:alert(1)" })).statusCode).toBe(400);
    const ok = await patch({ logo_dark_url: "https://cdn.example.com/dark.png" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tenant.brand.logo_dark_url).toBe("https://cdn.example.com/dark.png");
  });
});
