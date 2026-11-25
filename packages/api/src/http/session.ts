/**
 * Session resolution.
 *
 * Reads the session cookie on every request that matched a route and
 * resolves the tenant context into c.var.tenant (null when there is no
 * cookie, the session is unknown or expired, or the user is deactivated).
 * Public routes ignore it; dashboard routes require it (see router.ts).
 *
 * Product selection (multi-product instances): the request acts on the
 * product named by the `X-Claros-Product: <slug>` header or the `?product=`
 * query parameter (the header wins), else on the session's tenant. The user
 * may act on it with a membership row, as an instance admin (role owner), or
 * when it is their home product. Otherwise, and for an unknown slug, the
 * tenant stays null.
 */
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { matchedRoutes } from "hono/route";
import { storeFor } from "@claros/store";
import type { AppEnv } from "./env.js";
import type { UserRole } from "../types.js";

/** Name of the dashboard session cookie (unchanged since v0.6). */
export const SESSION_COOKIE_NAME = "claros_session";

/** True when the request matched a route handler (not only middleware). */
export function hasRouteHandler(c: Parameters<MiddlewareHandler<AppEnv>>[0]): boolean {
  return matchedRoutes(c).some((r) => r.method !== "ALL");
}

/** Header naming the product a dashboard request acts on. */
export const PRODUCT_HEADER = "x-claros-product";

/** The product slug a request names (header, then query), or null. */
export function requestedProductSlug(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  const fromHeader = c.req.header(PRODUCT_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  const fromQuery = c.req.query("product")?.trim();
  return fromQuery ? fromQuery : null;
}

export const resolveSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("tenant", null);
  if (!hasRouteHandler(c)) return next();

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  const db = c.var.db;
  if (!sessionId || !db) return next();

  // Session + product + user + access in one query (see apiSession.findSessionWithTenantAndUser).
  const row = await storeFor(db).apiSession.findSessionWithTenantAndUser(sessionId, requestedProductSlug(c));
  if (row && row.sessionExpiresAt >= new Date() && row.userDeactivatedAt === null) {
    c.set("tenant", {
      id: row.tenantId,
      slug: row.tenantSlug,
      userId: row.sessionUserId,
      userRole: row.userRole as UserRole,
      instanceRole: row.userInstanceRole === "admin" ? "admin" : null,
      archived: row.tenantArchivedAt != null,
    });
  }
  return next();
};
