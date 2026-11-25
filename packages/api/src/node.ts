/**
 * Node adapter for the HTTP app (`@claros/api/node`).
 *
 * Adds what only exists on Node to the runtime-neutral app from ./app.ts:
 *   - the built dashboard served from disk, with the SPA fallback
 *   - listen() on a socket (@hono/node-server) and close() of that server
 *
 * apps/server uses this entry. The Workers runtime (apps/worker) uses
 * `@claros/api` directly and serves the dashboard from Static Assets.
 */
import path from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";

import { buildApp as buildNeutralApp, type BuildAppOptions, type ClarosApp } from "./app.js";
import type { AppEnv } from "./http/env.js";
import type { AppLogger } from "./http/logger.js";
import { spaFallback, type StaticFallback } from "./http/spa.js";

export interface NodeBuildAppOptions extends Omit<BuildAppOptions, "staticFallback"> {
  /** Serve the built dashboard SPA and the SPA fallback. Defaults to false. */
  serveDashboard?: boolean;
  /** Absolute path of the dashboard dist directory (else CLAROS_DASHBOARD_DIST, else auto). */
  dashboardDist?: string;
}

/** The HTTP app on Node. */
export interface NodeClarosApp extends ClarosApp {
  /** Start an HTTP server. Resolves with the listening address. */
  listen(opts: { port: number; host?: string }): Promise<string>;
  /** Stop the server (closing all connections) if one was started. */
  close(): Promise<void>;
}

export async function buildApp(opts: NodeBuildAppOptions = {}): Promise<NodeClarosApp> {
  const { serveDashboard, dashboardDist, ...rest } = opts;
  const app = await buildNeutralApp({
    ...rest,
    staticFallback: serveDashboard ? (log) => prepareSpa({ dashboardDist }, log) : undefined,
  });

  let server: ServerType | null = null;

  return {
    ...app,
    listen: ({ port: listenPort, host }) =>
      new Promise((resolve, reject) => {
        const s = serve({ fetch: app.hono.fetch, port: listenPort, hostname: host }, (info) => {
          const address = `http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${info.port}`;
          app.log.info({}, `Server listening at ${address}`);
          resolve(address);
        });
        s.once("error", reject);
        server = s;
      }),
    close: () =>
      new Promise((resolve) => {
        if (!server) return resolve();
        const s = server as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void };
        s.closeAllConnections?.();
        s.close(() => resolve());
        server = null;
      }),
  };
}

// ---------------------------------------------------------------------------
// Static dashboard + SPA fallback from disk
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve files from the dashboard dist for GET/HEAD. Hashed files under
 * assets/ are cached for a year; everything else is no-store. Unknown
 * non-API GET/HEAD paths get index.html (client-side routing). API-prefixed
 * paths and other methods get a JSON 404 (rules in ./http/spa.ts).
 *
 * Returns null (and logs a warning) when the dist directory does not exist.
 */
function prepareSpa(opts: { dashboardDist?: string }, log: AppLogger): StaticFallback | null {
  const { distPath, mechanism } = resolvedDashboardDist(opts);
  if (!existsSync(distPath)) {
    log.warn(
      `[dashboard] serveDashboard=true but dist directory not found. ` +
        `mechanism=${mechanism} tried=${distPath} -- ` +
        "If mechanism=auto, verify WORKDIR is the monorepo root or set CLAROS_DASHBOARD_DIST explicitly. " +
        "Run `npm run build -w @claros/dashboard` to create the dist directory. " +
        "Static serving and SPA fallback are disabled until the path exists.",
    );
    return null;
  }
  const root = path.resolve(distPath);

  const sendFile = (c: Context<AppEnv>, filePath: string, cacheControl: string): Response => {
    const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const data = readFileSync(filePath);
    return new Response(c.req.method === "HEAD" ? null : data, {
      status: 200,
      headers: { "content-type": type, "cache-control": cacheControl, "content-length": String(data.length) },
    });
  };

  return spaFallback({
    file: (pathname, c) => {
      const candidate = path.resolve(root, `.${pathname}`);
      if (candidate.startsWith(root + path.sep) && existsSync(candidate) && statSync(candidate).isFile()) {
        const cache = candidate.includes(`${path.sep}assets${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-store";
        return sendFile(c, candidate, cache);
      }
      return null;
    },
    index: (c) => sendFile(c, path.join(root, "index.html"), "no-store"),
  });
}

/**
 * Resolve the absolute path to apps/dashboard/dist and how it was resolved:
 * opts.dashboardDist, then CLAROS_DASHBOARD_DIST, then relative to this file
 * (packages/api/{src,dist} -> three levels up is the repo root).
 */
export function resolvedDashboardDist(opts: { dashboardDist?: string }): {
  distPath: string;
  mechanism: "opts" | "env" | "auto";
} {
  if (opts.dashboardDist) return { distPath: opts.dashboardDist, mechanism: "opts" };
  if (process.env.CLAROS_DASHBOARD_DIST) return { distPath: process.env.CLAROS_DASHBOARD_DIST, mechanism: "env" };
  const __filename = fileURLToPath(import.meta.url);
  const monoRoot = path.resolve(path.dirname(__filename), "../../..");
  return { distPath: path.join(monoRoot, "apps", "dashboard", "dist"), mechanism: "auto" };
}

export type { BuildAppOptions, ClarosApp } from "./app.js";
