/**
 * Role enforcement plugin for the authenticated /v1 scope.
 *
 * Design:
 *   Every route registered inside the /v1 scope MUST declare its minimum
 *   required role via `config: { minRole: "member" | "owner" }`. If a route
 *   is registered without this declaration, the app REFUSES TO START with a
 *   clear error naming the offending route.
 *
 *   This inverts the usual pattern (opt-in restriction) to make omission
 *   impossible rather than safe. Most routes will declare "member", which is
 *   fine - the property we enforce is that the developer made a conscious
 *   choice.
 *
 * Enforcement layers:
 *   1. onRoute hook (boot time): rejects routes without config.minRole.
 *   2. preHandler hook (request time): checks request.tenant.userRole
 *      against the declared minRole and returns 403 if insufficient.
 */
import type { FastifyInstance } from "fastify";
import { roleSatisfies, type UserRole } from "../types.js";

// Extend Fastify's route config type to include our minRole declaration.
declare module "fastify" {
  interface FastifyContextConfig {
    /** Minimum role required to access this route. Must be declared. */
    minRole?: UserRole;
  }
}

/**
 * Register the role enforcement hooks on a Fastify scope.
 * Call this inside the /v1 scope registration, BEFORE any route plugins.
 *
 * @param scope - The encapsulated Fastify instance for the /v1 scope.
 */
export function registerRoleEnforcement(scope: FastifyInstance): void {
  // Track routes registered in this scope for the boot-time check.
  // Using onRoute hook to verify every route has a minRole declaration.
  scope.addHook("onRoute", (routeOptions) => {
    const minRole = routeOptions.config?.minRole;
    if (!minRole) {
      // Immediate boot failure. This is intentional: a missing declaration
      // is a programming error that must be caught before any request.
      throw new Error(
        `[role-enforcement] Route ${routeOptions.method} ${routeOptions.url} ` +
        `is registered in the authenticated /v1 scope but does not declare ` +
        `config.minRole. Every authenticated route must explicitly declare its ` +
        `minimum required role (e.g. config: { minRole: "member" }).`
      );
    }

    // Validate the value
    if (minRole !== "owner" && minRole !== "member") {
      throw new Error(
        `[role-enforcement] Route ${routeOptions.method} ${routeOptions.url} ` +
        `declares config.minRole="${minRole}" which is not a valid role. ` +
        `Valid values: "owner", "member".`
      );
    }
  });

  // Request-time enforcement: check the user's role against the route's minRole.
  scope.addHook("preHandler", async (request, reply) => {
    // If tenant is null, the auth preHandler already sent 401.
    if (!request.tenant) return;

    const minRole = request.routeOptions.config?.minRole as UserRole | undefined;
    if (!minRole) {
      // Should never happen (onRoute rejects it), but defensive.
      reply.status(500);
      reply.send({ error: "Internal error: route missing role declaration." });
      return;
    }

    if (!roleSatisfies(request.tenant.userRole, minRole)) {
      reply.status(403);
      reply.send({ error: "Forbidden: insufficient permissions." });
      return;
    }
  });
}
