/**
 * Products (multi-product instances). Code name: tenant.
 *
 * Endpoints:
 *   GET   /v1/products                  products the user can act on (member)
 *   POST  /v1/products                  create a product; the creator becomes its owner (instance admin)
 *   PATCH /v1/products/:slug            update name / locale / public_host (instance admin)
 *   POST  /v1/products/:slug/archive    archive: reads stay allowed, writes answer 409 (instance admin)
 *   POST  /v1/products/:slug/unarchive  unarchive (instance admin)
 *
 * An instance key (item 11) with products:write may list, create, update,
 * archive and unarchive products; instance:read may list them.
 *
 * The dashboard picks the product a request acts on with the
 * X-Claros-Product header (see http/session.ts). These routes are not
 * product-scoped, so an archived current product does not block them.
 */
import { z } from "zod";
import { storeFor, type ProductRow } from "@claros/store";
import { createRouter, parseBody } from "../http/router.js";
import { requireInstanceAdminOrKey } from "../http/admin-auth.js";
import type { AppContext } from "../http/env.js";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Lowercase letters, digits and inner hyphens, 2 to 63 characters. */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, "Must be 2 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen");

const nameSchema = z.string().trim().min(1).max(120);

/** A BCP 47 style language tag such as "en" or "pt-BR". */
const localeSchema = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Must be a language tag like en or pt-BR");

/** A bare host name such as "news.example.com" (no scheme, port or path). */
const hostSchema = z
  .string()
  .max(253)
  .transform((s) => s.trim().toLowerCase())
  .refine(
    (s) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s),
    { message: "Must be a host name like news.example.com" },
  );

const createSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema,
    locale: localeSchema.nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    locale: localeSchema.nullable().optional(),
    public_host: hostSchema.nullable().optional(),
  })
  .strict();

function validationError(c: AppContext, issues: z.ZodIssue[]): Response {
  return c.json(
    {
      error: "Validation failed",
      issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400,
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeProduct(p: ProductRow) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    locale: p.locale,
    public_host: p.publicHost,
    archived: p.archivedAt !== null,
    archived_at: p.archivedAt?.toISOString() ?? null,
    created_at: p.createdAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function productsRoutes() {
  const app = createRouter();
  const body = parseBody();

  /**
   * GET /v1/products
   * { products: [{ id, slug, name, role, archived }], instance_admin }
   * Instance admins see every product (role owner).
   */
  app.get("/", body, async (c, next) => {
    // Sessions of any member; without a session, an instance key with
    // products:write or instance:read (it sees every product).
    if (c.var.tenant) return next();
    return requireInstanceAdminOrKey("products:write", "instance:read")(c, next);
  }, async (c) => {
    const db: Db = c.var.db;
    const tenant = c.var.tenant;
    if (!tenant) {
      const rows = await storeFor(db).apiProducts.listAll();
      return c.json({
        products: rows.map((p) => ({ id: p.id, slug: p.slug, name: p.name, role: "owner", archived: p.archivedAt !== null })),
        instance_admin: false,
      });
    }
    const isAdmin = tenant.instanceRole === "admin";
    const rows = isAdmin
      ? (await storeFor(db).apiProducts.listAll()).map((p) => ({ ...p, role: "owner" }))
      : await storeFor(db).apiProducts.listForUser({ userId: tenant.userId });
    return c.json({
      products: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        role: p.role,
        archived: p.archivedAt !== null,
      })),
      instance_admin: isAdmin,
    });
  });

  /**
   * POST /v1/products  { name, slug, locale? } -> 201 { product }
   * 409 when the slug is taken.
   */
  app.post("/", body, requireInstanceAdminOrKey("products:write"), async (c) => {
    const parsed = createSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const { name, slug, locale } = parsed.data;

    const db: Db = c.var.db;
    const product = await storeFor(db).apiProducts.create({
      name,
      slug,
      locale: locale ?? null,
      ownerUserId: c.var.tenant ? c.var.tenant.userId : null,
    });
    if (!product) {
      return c.json({ error: "A product with this slug already exists." }, 409);
    }
    return c.json({ product: serializeProduct(product) }, 201);
  });

  /**
   * POST /v1/products/:slug/archive
   * POST /v1/products/:slug/unarchive
   */
  for (const [action, archived] of [["archive", true], ["unarchive", false]] as const) {
    app.post(`/:slug/${action}`, body, requireInstanceAdminOrKey("products:write"), async (c) => {
      const db: Db = c.var.db;
      const product = await storeFor(db).apiProducts.setArchived({
        slug: c.req.param("slug")!,
        archivedAt: archived ? new Date() : null,
      });
      if (!product) return c.json({ error: "Product not found." }, 404);
      return c.json({ product: serializeProduct(product) });
    });
  }

  /**
   * PATCH /v1/products/:slug  { name?, locale?, public_host? }
   * 409 when the public host is used by another product.
   */
  app.patch("/:slug", body, requireInstanceAdminOrKey("products:write"), async (c) => {
    const parsed = updateSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const { name, locale, public_host } = parsed.data;

    const db: Db = c.var.db;
    const result = await storeFor(db).apiProducts.update({
      slug: c.req.param("slug")!,
      name,
      locale,
      publicHost: public_host,
    });
    if (!result.ok) {
      return result.reason === "not_found"
        ? c.json({ error: "Product not found." }, 404)
        : c.json({ error: "Another product already uses this public host." }, 409);
    }
    return c.json({ product: serializeProduct(result.product) });
  });

  return app;
}
