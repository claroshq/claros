/**
 * Admin API keys for the management routes (G1).
 *
 * A management route accepts a dashboard session (with its product scope and
 * the route's minimum role) or a product admin key that carries the route's
 * scope: `Authorization: Bearer clr_ak_...`. Admin key requests act on the
 * key's product only; the X-Claros-Product header and ?product= are ignored.
 * Ingestion keys (publishable, secret) never authenticate a management
 * route, and admin keys never authenticate ingestion (see ingest-auth.ts).
 *
 * Only keys with the admin prefix are looked up, so ordinary dashboard
 * requests and ingestion traffic cost no extra query.
 *
 * Instance keys (`clr_ik_`, kind 'instance', no product) authenticate the
 * instance routes their scopes allow (products, instance read, people
 * erase) and, with keys:write or transports:write, a product's admin keys
 * and transports; the product comes from X-Claros-Product or ?product=
 * (400 when missing, 404 when unknown). They never authenticate ingestion
 * or any other product route, and product admin keys never authenticate
 * instance routes.
 */
import type { Context, MiddlewareHandler } from "hono";
import { storeFor } from "@claros/store";
import type { AppEnv } from "./env.js";
import { hashApiKey } from "./ingest-auth.js";
import { roleSatisfies, type TenantContext, type UserRole } from "../types.js";
import { requestedProductSlug } from "./session.js";

/** Management scopes an admin key can carry (02-CLAROS section 5.2). */
export const ADMIN_SCOPES = [
  "config",
  "suppressions",
  "messages",
  "contacts:read",
  "contacts:delete",
  "broadcasts",
  "kb",
] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

export function isAdminScope(v: unknown): v is AdminScope {
  return typeof v === "string" && (ADMIN_SCOPES as readonly string[]).includes(v);
}

/** Scopes an instance key can carry. */
export const INSTANCE_SCOPES = [
  "products:write",
  "keys:write",
  "transports:write",
  "instance:read",
  "people:erase",
] as const;
export type InstanceScope = (typeof INSTANCE_SCOPES)[number];

/** Raw-key prefixes of new keys. Keys created before them keep working. */
export const KEY_PREFIX = {
  publishable: "clr_pk_",
  secret: "clr_sk_",
  admin: "clr_ak_",
  instance: "clr_ik_",
} as const;

/** The bearer token of a request when it is an admin key, else null. */
export function bearerAdminKey(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  return raw.startsWith(KEY_PREFIX.admin) && raw.length > KEY_PREFIX.admin.length ? raw : null;
}

/** The bearer token of a request when it is an instance key, else null. */
export function bearerInstanceKey(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  return raw.startsWith(KEY_PREFIX.instance) && raw.length > KEY_PREFIX.instance.length ? raw : null;
}

/** Who acted, for approval columns and audit: "user:<id>" or "api_key:<id>". */
export function actorOf(tenant: TenantContext): string {
  return tenant.apiKeyId ? `api_key:${tenant.apiKeyId}` : `user:${tenant.userId}`;
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

function touchLastUsed(db: NonNullable<Context<AppEnv>["var"]["db"]>, id: string): void {
  const now = Date.now();
  if (now - (lastUsedWrites.get(id) ?? 0) >= LAST_USED_THROTTLE_MS) {
    lastUsedWrites.set(id, now);
    storeFor(db)
      .apiIngestAuth.touchKeyLastUsed(id, new Date(now))
      .catch(() => lastUsedWrites.delete(id));
  }
}

type InstanceKeyCheck =
  | { ok: true; id: string; scopes: string[] }
  | { ok: false; response: Response };

/**
 * Authenticate the request's instance key and check that it carries one of
 * `scopes`: 401 for an unknown or revoked key, 403 for a missing scope.
 */
export async function checkInstanceKey(c: Context<AppEnv>, raw: string, scopes: readonly InstanceScope[]): Promise<InstanceKeyCheck> {
  const db = c.var.db;
  const row = db ? await storeFor(db).apiAdminAuth.findActiveInstanceKeyByHash(hashApiKey(raw)) : null;
  if (!db || !row) return { ok: false, response: c.json({ error: "Invalid or revoked API key." }, 401) };
  if (!scopes.some((s) => row.scopes.includes(s))) {
    return { ok: false, response: c.json({ error: `Forbidden: this key lacks the '${scopes.join("' or '")}' scope.` }, 403) };
  }
  touchLastUsed(db, row.id);
  return { ok: true, id: row.id, scopes: row.scopes };
}

/**
 * Instance routes: a session of an instance admin, or an instance key with
 * one of `scopes`. Without scopes the route is for instance admin sessions
 * only (instance keys answer 403).
 */
export function requireInstanceAdminOrKey(...scopes: InstanceScope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.var.tenant;
    if (session) {
      if (session.instanceRole !== "admin") return c.json({ error: "Forbidden: instance admin only." }, 403);
      return next();
    }
    const raw = bearerInstanceKey(c);
    if (!raw) return c.json({ error: "Authentication required." }, 401);
    if (scopes.length === 0) {
      const known = await checkInstanceKey(c, raw, INSTANCE_SCOPES);
      if (!known.ok && known.response.status === 401) return known.response;
      return c.json({ error: "Forbidden: this route needs an instance admin session." }, 403);
    }
    const check = await checkInstanceKey(c, raw, scopes);
    if (!check.ok) return check.response;
    return next();
  };
}

/**
 * Route guard: a session with `minRole`, an admin key with `adminScope`, or
 * an instance key with `instanceScope` acting on the product the request
 * names. 401 without any of them (or with an unknown / revoked key), 403
 * when the role or scopes do not allow the route.
 */
export function requireRoleOrKey(minRole: UserRole, adminScope: AdminScope | null, instanceScope: InstanceScope | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.var.tenant;
    if (session) {
      if (!roleSatisfies(session.userRole, minRole)) {
        return c.json({ error: "Forbidden: insufficient permissions." }, 403);
      }
      return next();
    }
    const db = c.var.db;
    const instanceRaw = instanceScope ? bearerInstanceKey(c) : null;
    if (instanceRaw && instanceScope && db) {
      const check = await checkInstanceKey(c, instanceRaw, [instanceScope]);
      if (!check.ok) return check.response;
      const slug = requestedProductSlug(c);
      if (!slug) return c.json({ error: "Name the product: X-Claros-Product header or ?product=." }, 400);
      const product = await storeFor(db).apiAdminAuth.findProductBySlug(slug);
      if (!product) return c.json({ error: "Product not found." }, 404);
      c.set("tenant", {
        id: product.id,
        slug: product.slug,
        userId: "",
        userRole: "owner",
        instanceRole: null,
        archived: product.archivedAt != null,
        apiKeyId: check.id,
      });
      return next();
    }
    const raw = adminScope ? bearerAdminKey(c) : null;
    if (!raw || !db || !adminScope) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const row = await storeFor(db).apiAdminAuth.findActiveAdminKeyByHash(hashApiKey(raw));
    if (!row) {
      return c.json({ error: "Invalid or revoked API key." }, 401);
    }
    if (!row.scopes.includes(adminScope)) {
      return c.json({ error: `Forbidden: this key lacks the '${adminScope}' scope.` }, 403);
    }
    c.set("tenant", {
      id: row.tenantId,
      slug: row.tenantSlug,
      userId: "",
      userRole: "owner",
      instanceRole: null,
      archived: row.tenantArchivedAt != null,
      apiKeyId: row.id,
    });
    touchLastUsed(db, row.id);
    return next();
  };
}

/**
 * Route guard: a session with `minRole`, or an admin key with `scope`.
 * 401 without either (or with an unknown / revoked admin key), 403 when the
 * session's role or the key's scopes do not allow the route.
 */
export function requireRoleOrAdminKey(minRole: UserRole, scope: AdminScope): MiddlewareHandler<AppEnv> {
  return requireRoleOrKey(minRole, scope, null);
}
