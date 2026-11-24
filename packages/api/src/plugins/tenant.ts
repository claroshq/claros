/**
 * Tenant resolution plugin.
 *
 * Validates the session cookie on each request and resolves the tenant context.
 * Public routes (health, auth, unsubscribe) are registered outside the /v1
 * scope and do not require a resolved tenant.
 */
import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { sessions, tenants, users } from "@claros/db/schema";
import type { TenantContext, UserRole } from "../types.js";
import type { Db } from "./db.js";
import { SESSION_COOKIE_NAME } from "../routes/auth.js";

/**
 * Register tenant infrastructure on the Fastify instance.
 *
 * CONSTRAINT: this function must be called on the ROOT Fastify instance, never
 * inside an encapsulated child scope (i.e. never inside app.register()). Fastify
 * propagates decorateRequest and addHook downward from the scope they are
 * registered in. If this is called inside an encapsulated scope, the decoration
 * and the hook will be invisible to sibling and parent scopes - routes registered
 * elsewhere will throw "request.tenant is not defined" at runtime, and there will
 * be no build-time or startup error to catch it. The correct pattern is to call
 * registerTenantPlugin(app) directly in buildApp(), before any app.register() call.
 *
 * Must be called before any routes are registered.
 */
export function registerTenantPlugin(app: FastifyInstance): void {
  // Decorate every request with a null tenant.
  // The preHandler hook below will overwrite this with the resolved tenant
  // for authenticated requests.
  app.decorateRequest("tenant", null as TenantContext | null);

  // Pre-handler hook: resolve session -> tenant on every request.
  // Public routes simply ignore request.tenant (it stays null).
  // The /v1 scope enforces that request.tenant is not null.
  app.addHook("preHandler", async (request) => {
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      return; // No cookie - tenant stays null (public route or unauthenticated)
    }

    // If db is not available (no DB passed to buildApp), skip resolution.
    if (!request.server.db) {
      return;
    }

    const db: Db = request.server.db;

    // Look up session + tenant + user in one query.
    // The user JOIN ensures a session whose user row has been deleted
    // (e.g. via CASCADE) cannot authenticate a request.
    // The deactivated_at check ensures removed users cannot use residual sessions.
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

    if (rows.length === 0) {
      return; // Invalid session ID - tenant stays null
    }

    const row = rows[0]!;

    // Check session expiry
    if (row.sessionExpiresAt < new Date()) {
      return; // Expired session - tenant stays null
    }

    // Deactivated users cannot authenticate
    if (row.userDeactivatedAt !== null) {
      return; // Deactivated user - tenant stays null
    }

    // Resolve tenant with full user context
    request.tenant = {
      id: row.tenantId,
      slug: row.tenantSlug,
      userId: row.sessionUserId,
      userRole: row.userRole as UserRole,
    };
  });
}
