/**
 * Routers for the dashboard API.
 *
 * Every route in the authenticated /v1 scope must declare the minimum role
 * that may call it. v0.6 enforced this at boot; here the route methods take
 * the role as a required argument, so omitting it is a type error, and an
 * invalid value fails at registration time.
 *
 * Request-time order per route, as in v0.6: body parsing (400/413/415 on bad
 * bodies), then a resolved session tenant (else 401), then the declared role
 * (else 403), then, for non-GET routes, a product that is not archived
 * (else 409). Response bodies match v0.6.
 *
 * Public routers (createRouter) add `parseBody()` themselves on every route
 * that reads a body.
 */
import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import { bodyParser, type BodyOptions } from "./body.js";
import { validateBody } from "./validate.js";
import type { z } from "zod";
import { roleSatisfies, type UserRole } from "../types.js";
import { requireRoleOrKey, type AdminScope, type InstanceScope } from "./admin-auth.js";

/** Hono app typed with the Claros environment. */
export function createRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>({ strict: false });
}

/** Per-route body parsing middleware (see body.ts). */
export const parseBody = bodyParser;

const PRE_AUTH = Symbol("claros.preAuth");
type PreAuthMiddleware = MiddlewareHandler<AppEnv> & { [PRE_AUTH]: true };

/**
 * Body schema check that runs before the session/role check, as v0.6's
 * schema validation did (a bad body answered 400 even without a session).
 * Pass it to a RoleRouter route right after the role. The handler still
 * reads the validated value with validateBody (same schema, same result).
 */
export function validatedBody<S extends z.ZodTypeAny>(schema: S): PreAuthMiddleware {
  const mw: MiddlewareHandler<AppEnv> = async (c, next) => {
    const v = validateBody(c, schema);
    if (!v.ok) return v.response;
    return next();
  };
  return Object.assign(mw, { [PRE_AUTH]: true as const });
}

const KEY_SCOPE = Symbol("claros.adminKeyScope");
type AdminKeyMarker = MiddlewareHandler<AppEnv> & { [KEY_SCOPE]: AdminScope };

/**
 * Let a RoleRouter route also accept a product admin key that carries
 * `scope` (G1). Pass it right after the role. Without it, a route accepts
 * sessions only.
 */
export function allowAdminKey(scope: AdminScope): AdminKeyMarker {
  const mw: MiddlewareHandler<AppEnv> = async (_c, next) => next();
  return Object.assign(mw, { [KEY_SCOPE]: scope });
}

const INSTANCE_KEY_SCOPE = Symbol("claros.instanceKeyScope");
type InstanceKeyMarker = MiddlewareHandler<AppEnv> & { [INSTANCE_KEY_SCOPE]: InstanceScope };

/**
 * Let a RoleRouter route also accept an instance key that carries `scope`,
 * acting on the product named by X-Claros-Product or ?product= (item 11).
 * Pass it right after the role.
 */
export function allowInstanceKey(scope: InstanceScope): InstanceKeyMarker {
  const mw: MiddlewareHandler<AppEnv> = async (_c, next) => next();
  return Object.assign(mw, { [INSTANCE_KEY_SCOPE]: scope });
}

export function requireRole(minRole: UserRole): MiddlewareHandler<AppEnv> {
  if (minRole !== "owner" && minRole !== "member") {
    throw new Error(
      `[role-enforcement] minRole="${String(minRole)}" is not a valid role. Valid values: "owner", "member".`,
    );
  }
  return async (c, next) => {
    const tenant = c.var.tenant;
    if (!tenant) {
      return c.json({ error: "Authentication required." }, 401);
    }
    if (!roleSatisfies(tenant.userRole, minRole)) {
      return c.json({ error: "Forbidden: insufficient permissions." }, 403);
    }
    return next();
  };
}

/**
 * Instance admin check for instance-level routes (products, instance
 * settings): 401 without a resolved session tenant, 403 unless the user's
 * instance role is "admin".
 */
export const requireInstanceAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tenant = c.var.tenant;
  if (!tenant) {
    return c.json({ error: "Authentication required." }, 401);
  }
  if (tenant.instanceRole !== "admin") {
    return c.json({ error: "Forbidden: instance admin only." }, 403);
  }
  return next();
};

/** Archived products are read-only: non-GET dashboard routes answer 409. */
const rejectArchivedWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.tenant?.archived) {
    return c.json({ error: "Product is archived." }, 409);
  }
  return next();
};

type Method = "get" | "post" | "put" | "patch" | "delete";

/**
 * A router whose route methods require a minimum role. Mount `.app` under a
 * prefix inside the authenticated /v1 scope.
 */
export class RoleRouter {
  readonly app: Hono<AppEnv> = createRouter();
  private readonly body: MiddlewareHandler<AppEnv>;

  /** @param bodyOptions extra body parsers or a size limit for this router's routes */
  constructor(bodyOptions: BodyOptions = {}) {
    this.body = bodyParser(bodyOptions);
  }

  private add(method: Method, path: string, minRole: UserRole, handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    const marker = handlers.find((h) => (h as Partial<AdminKeyMarker>)[KEY_SCOPE] !== undefined) as
      | AdminKeyMarker
      | undefined;
    const instanceMarker = handlers.find((h) => (h as Partial<InstanceKeyMarker>)[INSTANCE_KEY_SCOPE] !== undefined) as
      | InstanceKeyMarker
      | undefined;
    const guard =
      marker || instanceMarker
        ? requireRoleOrKey(minRole, marker?.[KEY_SCOPE] ?? null, instanceMarker?.[INSTANCE_KEY_SCOPE] ?? null)
        : requireRole(minRole);
    handlers = handlers.filter((h) => h !== marker && h !== instanceMarker);
    const preAuth = handlers.filter((h) => (h as Partial<PreAuthMiddleware>)[PRE_AUTH] === true);
    const rest = handlers.filter((h) => (h as Partial<PreAuthMiddleware>)[PRE_AUTH] !== true);
    (this.app[method] as (p: string, ...h: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]) => unknown)(
      path,
      this.body,
      ...preAuth,
      guard,
      ...(method === "get" ? [] : [rejectArchivedWrites]),
      ...rest,
    );
    return this;
  }

  get(path: string, minRole: UserRole, ...handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    return this.add("get", path, minRole, handlers);
  }
  post(path: string, minRole: UserRole, ...handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    return this.add("post", path, minRole, handlers);
  }
  put(path: string, minRole: UserRole, ...handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    return this.add("put", path, minRole, handlers);
  }
  patch(path: string, minRole: UserRole, ...handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    return this.add("patch", path, minRole, handlers);
  }
  delete(path: string, minRole: UserRole, ...handlers: (Handler<AppEnv> | MiddlewareHandler<AppEnv>)[]): this {
    return this.add("delete", path, minRole, handlers);
  }
}
