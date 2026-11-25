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
 */
import type { Context, MiddlewareHandler } from "hono";
import { storeFor } from "@claros/store";
import type { AppEnv } from "./env.js";
import { hashApiKey } from "./ingest-auth.js";
import { roleSatisfies, type TenantContext, type UserRole } from "../types.js";

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

/** Raw-key prefixes of new keys. Keys created before them keep working. */
export const KEY_PREFIX = {
  publishable: "clr_pk_",
  secret: "clr_sk_",
  admin: "clr_ak_",
} as const;

/** The bearer token of a request when it is an admin key, else null. */
export function bearerAdminKey(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  return raw.startsWith(KEY_PREFIX.admin) && raw.length > KEY_PREFIX.admin.length ? raw : null;
}

/** Who acted, for approval columns and audit: "user:<id>" or "api_key:<id>". */
export function actorOf(tenant: TenantContext): string {
  return tenant.apiKeyId ? `api_key:${tenant.apiKeyId}` : `user:${tenant.userId}`;
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

/**
 * Route guard: a session with `minRole`, or an admin key with `scope`.
 * 401 without either (or with an unknown / revoked admin key), 403 when the
 * session's role or the key's scopes do not allow the route.
 */
export function requireRoleOrAdminKey(minRole: UserRole, scope: AdminScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.var.tenant;
    if (session) {
      if (!roleSatisfies(session.userRole, minRole)) {
        return c.json({ error: "Forbidden: insufficient permissions." }, 403);
      }
      return next();
    }
    const raw = bearerAdminKey(c);
    const db = c.var.db;
    if (!raw || !db) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const row = await storeFor(db).apiAdminAuth.findActiveAdminKeyByHash(hashApiKey(raw));
    if (!row) {
      return c.json({ error: "Invalid or revoked API key." }, 401);
    }
    if (!row.scopes.includes(scope)) {
      return c.json({ error: `Forbidden: this key lacks the '${scope}' scope.` }, 403);
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
    const now = Date.now();
    if (now - (lastUsedWrites.get(row.id) ?? 0) >= LAST_USED_THROTTLE_MS) {
      lastUsedWrites.set(row.id, now);
      storeFor(db)
        .apiIngestAuth.touchKeyLastUsed(row.id, new Date(now))
        .catch(() => lastUsedWrites.delete(row.id));
    }
    return next();
  };
}
