/**
 * Session resolution.
 *
 * Reads the session cookie on every request that matched a route and
 * resolves the tenant context into c.var.tenant (null when there is no
 * cookie, the session is unknown or expired, or the user is deactivated).
 * Public routes ignore it; dashboard routes require it (see router.ts).
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

export const resolveSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("tenant", null);
  if (!hasRouteHandler(c)) return next();

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  const db = c.var.db;
  if (!sessionId || !db) return next();

  // Session + tenant + user in one query (see apiSession.findSessionWithTenantAndUser).
  const row = await storeFor(db).apiSession.findSessionWithTenantAndUser(sessionId);
  if (row && row.sessionExpiresAt >= new Date() && row.userDeactivatedAt === null) {
    c.set("tenant", {
      id: row.tenantId,
      slug: row.tenantSlug,
      userId: row.sessionUserId,
      userRole: row.userRole as UserRole,
    });
  }
  return next();
};
