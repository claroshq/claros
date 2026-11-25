/**
 * Uploaded brand logo (v0.8.5).
 *
 * Management (owner session, or a product admin key with the `config` scope;
 * GET also for members):
 *   GET    /v1/settings/brand/logo   the uploaded logo's metadata, or { logo: null }
 *   POST   /v1/settings/brand/logo   upload: the body is the image bytes,
 *                                    Content-Type image/png or image/jpeg
 *   DELETE /v1/settings/brand/logo   remove the uploaded logo
 *
 * Upload rules: PNG or JPEG only, decided by the file's magic bytes (the
 * declared Content-Type must agree); anything else, SVG included, is 415.
 * At most 256 KB (413). Width and height are read from the image header.
 * On upload brand.logo_url becomes the hosted URL below with
 * `?v=<first 12 hex chars of the SHA-256>`, and brand.logo_height is set
 * from the image's aspect ratio when it is unset (at most 48 px high and
 * 240 px wide). Deleting the logo also clears brand.logo_url when it points
 * at the hosted logo; an external logo_url is left alone.
 *
 * Public serving (no auth):
 *   GET /brand/logo          on a product's public host: that product's logo
 *   GET /brand/:slug/logo    on the instance host: any product's logo; on a
 *                            product's public host only that product's slug
 * The hosted URL is https://<public_host>/brand/logo for a product with a
 * public host, else <BASE_URL>/brand/<slug>/logo. The current logo is served
 * for any `v`, so mail sent with an older URL keeps showing a logo. A `v`
 * that matches the current logo gets a one-year immutable cache; other
 * requests a short one. 404 when the product has no uploaded logo.
 *
 * Config as code: GET /v1/config exports brand.logo_url as stored (the
 * hosted URL), so applying an exported document again changes nothing. A
 * document that sets brand.logo_url to another URL wins; the uploaded bytes
 * stay stored until DELETE.
 */
import { createHash } from "node:crypto";
import { storeFor, type BrandAssetRow, type BrandProductRow } from "@claros/store";
import { BRAND_LOGO_MAX_BYTES, BRAND_LOGO_TYPES, defaultBrandLogoHeight, inspectBrandLogo } from "@claros/core";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey, createRouter } from "../http/router.js";

/** Hex characters of the SHA-256 in the ?v= cache key. */
const VERSION_CHARS = 12;
/** Cache lifetime of a logo requested without the current ?v=. */
const SHORT_MAX_AGE_SECONDS = 300;

const sizeLimitKb = BRAND_LOGO_MAX_BYTES / 1024;

/** The hosted logo URL without its ?v= query. */
function hostedLogoBase(product: Pick<BrandProductRow, "slug" | "publicHost">, baseUrl: string): string {
  return product.publicHost
    ? `https://${product.publicHost}/brand/logo`
    : `${baseUrl}/brand/${encodeURIComponent(product.slug)}/logo`;
}

function hostedLogoUrl(product: Pick<BrandProductRow, "slug" | "publicHost">, baseUrl: string, sha256: string): string {
  return `${hostedLogoBase(product, baseUrl)}?v=${sha256.slice(0, VERSION_CHARS)}`;
}

/** True when url points at this product's hosted logo (either host form, any ?v=). */
function isHostedLogoUrl(url: unknown, product: Pick<BrandProductRow, "slug" | "publicHost">, baseUrl: string): boolean {
  if (typeof url !== "string") return false;
  const bare = url.split("?")[0]!.split("#")[0]!;
  const forms = [`${baseUrl}/brand/${encodeURIComponent(product.slug)}/logo`];
  if (product.publicHost) forms.push(`https://${product.publicHost}/brand/logo`);
  return forms.includes(bare);
}

function settingsOf(product: BrandProductRow): Record<string, unknown> {
  return (product.settings as Record<string, unknown> | null) ?? {};
}

function brandView(settings: Record<string, unknown>) {
  const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};
  return {
    brand_name: (brand.brand_name as string | undefined) ?? null,
    logo_url: (brand.logo_url as string | undefined) ?? null,
    logo_height: (brand.logo_height as number | undefined) ?? null,
    accent_color: (brand.accent_color as string | undefined) ?? null,
    footer_text: (brand.footer_text as string | undefined) ?? null,
    reply_to: (brand.reply_to as string | undefined) ?? null,
  };
}

function logoView(logo: Omit<BrandAssetRow, "updatedAt"> & { updatedAt: Date }, product: BrandProductRow, baseUrl: string) {
  const brand = (settingsOf(product).brand as Record<string, unknown> | undefined) ?? {};
  return {
    url: hostedLogoUrl(product, baseUrl, logo.sha256),
    content_type: logo.contentType,
    width: logo.width,
    height: logo.height,
    size: logo.bytes.byteLength,
    sha256: logo.sha256,
    updated_at: logo.updatedAt,
    /** True when brand.logo_url points at this uploaded logo. */
    in_use: isHostedLogoUrl(brand.logo_url, product, baseUrl),
  };
}

/** Management routes, mounted at /v1/settings/brand. */
export function brandSettingsRoutes(opts: { baseUrl: string }) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  // Image bodies reach the handler as bytes, so a wrong image type gets a
  // clear 415 from the handler instead of the generic parser error.
  const r = new RoleRouter({ binary: (type) => type.startsWith("image/") });

  r.get("/logo", "member", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const product = await storeFor(db).apiBrand.findProduct(tenantId);
    if (!product) return c.json({ error: "Product not found." }, 404);
    const logo = await storeFor(db).apiBrand.getLogo(tenantId);
    return c.json({ logo: logo ? logoView(logo, product, baseUrl) : null });
  });

  r.post("/logo", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const body = c.var.body;
    const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const typeHint = `The logo must be a PNG or JPEG image, sent as the request body with Content-Type ${BRAND_LOGO_TYPES.join(" or ")}.`;

    if (!(body instanceof Uint8Array) || !(BRAND_LOGO_TYPES as readonly string[]).includes(declared)) {
      return c.json({ error: typeHint }, 415);
    }
    if (body.byteLength === 0) {
      return c.json({ error: "The request body is empty. " + typeHint }, 400);
    }
    if (body.byteLength > BRAND_LOGO_MAX_BYTES) {
      return c.json({ error: `The logo must be at most ${sizeLimitKb} KB.` }, 413);
    }
    const info = inspectBrandLogo(body);
    if (!info) {
      return c.json({ error: "The file is not a readable PNG or JPEG image. " + typeHint }, 415);
    }
    if (info.contentType !== declared) {
      return c.json({ error: `Content-Type is ${declared} but the file is ${info.contentType}.` }, 415);
    }

    const product = await storeFor(db).apiBrand.findProduct(tenantId);
    if (!product) return c.json({ error: "Product not found." }, 404);

    const sha256 = createHash("sha256").update(body).digest("hex");
    const settings = settingsOf(product);
    const brand = { ...((settings.brand as Record<string, unknown> | undefined) ?? {}) };
    brand.logo_url = hostedLogoUrl(product, baseUrl, sha256);
    if (typeof brand.logo_height !== "number") brand.logo_height = defaultBrandLogoHeight(info.width, info.height);
    const nextSettings = { ...settings, brand };

    const now = new Date();
    const logo = { contentType: info.contentType, bytes: body, width: info.width, height: info.height, sha256 };
    await storeFor(db).apiBrand.saveLogo({ tenantId, logo, settings: nextSettings, now });

    const saved = { ...product, settings: nextSettings };
    return c.json({ logo: logoView({ ...logo, updatedAt: now }, saved, baseUrl), brand: brandView(nextSettings) }, 201);
  });

  r.delete("/logo", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const product = await storeFor(db).apiBrand.findProduct(tenantId);
    if (!product) return c.json({ error: "Product not found." }, 404);

    const settings = settingsOf(product);
    const brand = { ...((settings.brand as Record<string, unknown> | undefined) ?? {}) };
    let nextSettings: Record<string, unknown> | undefined;
    if (isHostedLogoUrl(brand.logo_url, product, baseUrl)) {
      delete brand.logo_url;
      nextSettings = { ...settings, brand };
    }
    const deleted = await storeFor(db).apiBrand.deleteLogo({ tenantId, settings: nextSettings });
    if (!deleted) return c.json({ error: "No uploaded logo." }, 404);
    return c.json({ deleted: true, brand: brandView(nextSettings ?? settings) });
  });

  return r.app;
}

/** Lowercase host name of the request (no port). */
function requestHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function serveLogo(logo: BrandAssetRow, version: string | undefined): Response {
  const current = version !== undefined && version.length > 0 && logo.sha256.startsWith(version.toLowerCase());
  return new Response(logo.bytes, {
    status: 200,
    headers: {
      "content-type": logo.contentType,
      "content-length": String(logo.bytes.byteLength),
      "cache-control": current ? "public, max-age=31536000, immutable" : `public, max-age=${SHORT_MAX_AGE_SECONDS}`,
      etag: `"${logo.sha256}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

const NOT_FOUND = { error: "Not Found" } as const;

/**
 * Public routes, mounted at /brand. A product's public host serves only
 * that product; the instance host serves every product by slug.
 */
export function publicBrandRoutes() {
  const app = createRouter();

  const respond = async (db: Db, tenantId: string, version: string | undefined, ifNoneMatch: string | undefined) => {
    const logo = await storeFor(db).apiBrand.getLogo(tenantId);
    if (!logo) return null;
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${logo.sha256}"`)) {
      const res = serveLogo(logo, version);
      return new Response(null, { status: 304, headers: { etag: res.headers.get("etag")!, "cache-control": res.headers.get("cache-control")! } });
    }
    return serveLogo(logo, version);
  };

  app.get("/logo", async (c) => {
    const db: Db = c.var.db;
    const host = requestHost(c.req.url);
    const product = host ? await storeFor(db).apiBrand.findProductByPublicHost(host) : null;
    if (!product) return c.json(NOT_FOUND, 404);
    const res = await respond(db, product.id, c.req.query("v"), c.req.header("if-none-match"));
    return res ?? c.json(NOT_FOUND, 404);
  });

  app.get("/:slug/logo", async (c) => {
    const db: Db = c.var.db;
    const slug = c.req.param("slug");
    const host = requestHost(c.req.url);
    const hostProduct = host ? await storeFor(db).apiBrand.findProductByPublicHost(host) : null;
    if (hostProduct && hostProduct.slug !== slug) return c.json(NOT_FOUND, 404);
    const product = hostProduct ?? (await storeFor(db).apiBrand.findProductBySlug(slug));
    if (!product) return c.json(NOT_FOUND, 404);
    const res = await respond(db, product.id, c.req.query("v"), c.req.header("if-none-match"));
    return res ?? c.json(NOT_FOUND, 404);
  });

  return app;
}
