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
import { eq } from "drizzle-orm";
import { sessions, tenants, users } from "@claros/db/schema";
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

  // Session + tenant + user in one query. The user join makes a session whose
  // user row is gone unusable; deactivated users cannot authenticate.
  const rows = await db
    .select({
      sessionUserId: sessions.userId,
      sessionExpiresAt: sessions.expiresAt,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      userRole: users.role,
      userDeactivatedAt: users.deactivatedAt,
    })
    .from(sessions)
    .innerJoin(tenants, eq(sessions.tenantId, tenants.id))
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
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
