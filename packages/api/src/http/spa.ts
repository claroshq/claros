/**
 * SPA fallback rules for the dashboard, shared by every runtime.
 *
 * The Hono app answers its own routes. A request no route matched reaches the
 * not-found handler, which hands it to the runtime's static fallback (when the
 * runtime serves the dashboard):
 *
 *   - methods other than GET/HEAD: JSON 404
 *   - API-prefixed paths (an unknown /v1/whatever): JSON 404
 *   - a file that exists in the dashboard build: that file
 *   - anything else: index.html (client-side routing)
 *
 * Where the files come from is the runtime's business: the Node adapter reads
 * them from disk (src/node.ts), the Workers runtime from the Static Assets
 * binding (apps/worker).
 */
import type { Context } from "hono";
import type { AppEnv } from "./env.js";

/**
 * Top-level path prefixes owned by API routes. The SPA fallback never serves
 * index.html for these; an unknown /v1/whatever is a JSON 404.
 */
export const API_PATH_PREFIXES = [
  "/health",
  "/version",
  "/auth",
  "/invite",
  "/unsubscribe",
  "/webhooks",
  "/v1",
] as const;

/** True when a decoded URL pathname belongs to the API. */
export function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Answers a request that matched no route. */
export type StaticFallback = (c: Context<AppEnv>) => Response | Promise<Response>;

/** Where the dashboard files come from. */
export interface StaticFiles {
  /** The file at a decoded URL pathname, or null when there is none. */
  file(pathname: string, c: Context<AppEnv>): Response | null | Promise<Response | null>;
  /** index.html, served for client-side routes. */
  index(c: Context<AppEnv>): Response | Promise<Response>;
}

/** The SPA fallback over a runtime's static files. */
export function spaFallback(files: StaticFiles): StaticFallback {
  return async (c) => {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return c.json({ error: "Not Found" }, 404);
    }
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (isApiPath(pathname)) {
      return c.json({ error: "Not Found" }, 404);
    }
    return (await files.file(pathname, c)) ?? files.index(c);
  };
}
