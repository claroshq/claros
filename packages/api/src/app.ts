/**
 * HTTP app factory (Hono).
 *
 * Builds the Claros HTTP API. Called by apps/server when the role includes
 * the API (role=all or role=api). The external HTTP API is the v0.6 API:
 * same routes (tests/contract/v0.6-routes.txt), status codes, bodies and
 * framework error shapes.
 *
 * Assembly:
 *   1. Context: db, enqueue, logger; session -> tenant resolution
 *   2. Public routes: health, version, auth, claim, unsubscribe, invite, webhooks
 *   3. Dashboard routes under /v1 (session cookie + per-route minimum role)
 *   4. Ingestion routes under /v1 (API key auth, CORS)
 *   5. Static dashboard + SPA fallback (only when serveDashboard is true)
 */
import path from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";

import type { AppEnv } from "./http/env.js";
import type { Db, EnqueueFn } from "./plugins/db.js";
import { resolveSession } from "./http/session.js";
import { bodyParser } from "./http/body.js";
import { frameworkError, notFound } from "./http/errors.js";
import { inject, type InjectOptions, type InjectResponse } from "./http/inject.js";
import { createLogger, type AppLogger, type LoggerOption } from "./http/logger.js";
import healthRoutes from "./routes/health.js";
import versionRoutes from "./routes/version.js";
import diagnosticsRoutes from "./routes/diagnostics.js";
import authRoutes from "./routes/auth.js";
import claimRoutes from "./routes/claim.js";
import inviteRoutes from "./routes/invite.js";
import ingestRoutes from "./routes/ingest.js";
import flowsRoutes from "./routes/flows.js";
import contactsRoutes from "./routes/contacts.js";
import analyticsRoutes from "./routes/analytics.js";
import kbRoutes from "./routes/kb.js";
import suppressionRoutes from "./routes/suppressions.js";
import templatesRoutes from "./routes/templates.js";
import messagesRoutes from "./routes/messages.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import ingestionRoutes from "./routes/ingestion.js";
import resendWebhookRoutes from "./routes/webhooks/resend.js";
import settingsRoutes from "./routes/settings.js";
import libraryRoutes from "./routes/library.js";
import emailTemplatesRoutes from "./routes/email-templates.js";
import eventsRoutes from "./routes/events.js";
import sentLogRoutes from "./routes/sent-log.js";
import teamRoutes from "./routes/team.js";
import profileRoutes from "./routes/profile.js";

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

export interface BuildAppOptions {
  /** Process role reported in /health. Defaults to "all". */
  role?: string;
  /** Edition label reported in /health and /version. Always "community"; kept for v0.6 compatibility. */
  edition?: string;
  /** Logger: false silences, { level } configures, or pass an object with debug/info/warn/error. */
  logger?: LoggerOption;
  /** Drizzle database client. Most routes are registered only when it is provided. */
  db?: Db;
  /** Job enqueue function (pg-boss send on Node). */
  enqueue?: EnqueueFn;
  /** Base URL of the API (magic links, unsubscribe links). */
  baseUrl?: string;
  /** Dashboard URL for post-login redirects. Defaults to baseUrl. */
  dashboardUrl?: string;
  /** Serve the built dashboard SPA and the SPA fallback. Defaults to false. */
  serveDashboard?: boolean;
  /** Absolute path of the dashboard dist directory (else CLAROS_DASHBOARD_DIST, else auto). */
  dashboardDist?: string;
  /** One-time claim token for the first account; claim routes exist only while it is set. */
  claimToken?: string | null;
}

/** The running HTTP app. */
export interface ClarosApp {
  /** The underlying Hono app (fetch handler). */
  readonly hono: Hono<AppEnv>;
  readonly log: AppLogger;
  fetch(request: Request): Response | Promise<Response>;
  /** In-process request with the v0.6 `inject()` shape (tests, tooling). */
  inject(opts: InjectOptions | string): Promise<InjectResponse>;
  /** Kept for v0.6 call sites; the app is ready once built. */
  ready(): Promise<void>;
  /** Start an HTTP server on Node. Resolves with the listening address. */
  listen(opts: { port: number; host?: string }): Promise<string>;
  /** Stop the server (closing all connections) if one was started. */
  close(): Promise<void>;
  /** Registered routes as sorted "METHOD /path" lines (HEAD/OPTIONS/middleware left out). */
  routes(): string[];
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<ClarosApp> {
  const role = opts.role ?? "all";
  const edition = opts.edition ?? "community";
  const port = process.env.PORT ?? "3000";
  const baseUrl = opts.baseUrl ?? process.env.BASE_URL ?? `http://localhost:${port}`;
  const dashboardUrl = opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? baseUrl;
  const log = createLogger(
    opts.logger !== undefined ? opts.logger : process.env.NODE_ENV === "test" ? false : undefined,
  );

  const app = new Hono<AppEnv>({ strict: false });

  // --- Context ---------------------------------------------------------------
  app.use("*", async (c, next) => {
    c.set("db", opts.db as Db);
    c.set("enqueue", opts.enqueue);
    c.set("log", log);
    c.set("ingestTenant", null);
    c.set("body", undefined);
    return next();
  });
  app.use("*", resolveSession);

  // v0.6 sent "application/json; charset=utf-8" and "text/plain; charset=utf-8".
  app.use("*", async (c, next) => {
    await next();
    const type = c.res.headers.get("content-type");
    if (type === "application/json") {
      c.res.headers.set("content-type", "application/json; charset=utf-8");
    } else if (type === "text/plain; charset=UTF-8") {
      c.res.headers.set("content-type", "text/plain; charset=utf-8");
    }
  });

  // --- Public routes ---------------------------------------------------------
  app.route("/", healthRoutes({ role, edition }));
  app.route("/", versionRoutes({ edition }));

  if (opts.db) {
    app.route("/auth", authRoutes({ baseUrl, dashboardUrl }));
  }

  if (opts.db && opts.claimToken != null) {
    let activeClaimToken: string | null = opts.claimToken;
    app.route(
      "/claim",
      claimRoutes({
        getClaimToken: () => activeClaimToken,
        consumeClaimToken: () => {
          activeClaimToken = null;
        },
        dashboardUrl,
      }),
    );
  }

  if (opts.db) {
    app.route("/unsubscribe", unsubscribeRoutes());
    app.route("/invite", inviteRoutes({ dashboardUrl }));
    app.route("/webhooks/resend", resendWebhookRoutes());
  }

  // --- Dashboard routes (session cookie, per-route minimum role) --------------
  if (opts.db) {
    app.route("/v1/flows", flowsRoutes());
    app.route("/v1/contacts", contactsRoutes());
    app.route("/v1/analytics", analyticsRoutes());
    app.route("/v1/kb", kbRoutes());
    app.route("/v1/suppressions", suppressionRoutes());
    app.route("/v1/templates", templatesRoutes());
    app.route("/v1/messages", messagesRoutes());
    app.route("/v1/settings", settingsRoutes());
    app.route("/v1/ingestion", ingestionRoutes());
    app.route("/v1/library", libraryRoutes());
    app.route("/v1/email-templates", emailTemplatesRoutes());
    app.route("/v1/events", eventsRoutes());
    app.route("/v1/sent-log", sentLogRoutes());
    app.route("/v1/team", teamRoutes());
    app.route("/v1/profile", profileRoutes());
  }
  app.route("/v1/diagnostics", diagnosticsRoutes());

  // --- Ingestion routes (API key auth) ------------------------------------------
  if (opts.db) {
    app.route("/v1", ingestRoutes());
  }

  // --- Errors ----------------------------------------------------------------
  app.onError((err, c) => {
    log.error({ err: { message: err.message, stack: err.stack }, url: c.req.url }, "request failed");
    return frameworkError(c, 500, undefined, err.message);
  });

  const spa = opts.serveDashboard ? prepareSpa(opts, log) : null;
  // v0.6 parsed the body before answering 404, so a broken body on an
  // unknown route still got the 400/413/415 parse error.
  const notFoundBody = bodyParser();
  app.notFound(async (c) => {
    const parseError = await notFoundBody(c as Context<AppEnv>, async () => {});
    if (parseError instanceof Response) return parseError;
    return spa ? spa(c as Context<AppEnv>) : notFound(c);
  });

  // --- Wrapper -----------------------------------------------------------------
  let server: ServerType | null = null;

  return {
    hono: app,
    log,
    fetch: (request) => app.fetch(request),
    inject: (o) => inject(app, o),
    ready: async () => {},
    listen: ({ port: listenPort, host }) =>
      new Promise((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port: listenPort, hostname: host }, (info) => {
          const address = `http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${info.port}`;
          log.info({}, `Server listening at ${address}`);
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
    routes: () => listRoutes(app),
  };
}

/** Registered routes of a Hono app as sorted "METHOD /path" lines. */
export function listRoutes(app: Hono<AppEnv>): string[] {
  const out = new Set<string>();
  for (const r of app.routes) {
    if (r.method === "ALL" || r.method === "HEAD" || r.method === "OPTIONS") continue;
    out.add(`${r.method} ${r.path.length > 1 ? r.path.replace(/\/$/, "") : r.path}`);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Static dashboard + SPA fallback
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
 * paths and other methods get a JSON 404.
 *
 * Returns null (and logs a warning) when the dist directory does not exist.
 */
function prepareSpa(opts: BuildAppOptions, log: AppLogger): ((c: Context<AppEnv>) => Response) | null {
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

  return (c) => {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return c.json({ error: "Not Found" }, 404);
    }
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);

    const isApiPath = API_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (isApiPath) {
      return c.json({ error: "Not Found" }, 404);
    }

    const candidate = path.resolve(root, `.${pathname}`);
    if (candidate.startsWith(root + path.sep) && existsSync(candidate) && statSync(candidate).isFile()) {
      const cache = candidate.includes(`${path.sep}assets${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-store";
      return sendFile(c, candidate, cache);
    }
    return sendFile(c, path.join(root, "index.html"), "no-store");
  };
}

/**
 * Resolve the absolute path to apps/dashboard/dist and how it was resolved:
 * opts.dashboardDist, then CLAROS_DASHBOARD_DIST, then relative to this file
 * (packages/api/{src,dist} -> three levels up is the repo root).
 */
export function resolvedDashboardDist(opts: BuildAppOptions): { distPath: string; mechanism: "opts" | "env" | "auto" } {
  if (opts.dashboardDist) return { distPath: opts.dashboardDist, mechanism: "opts" };
  if (process.env.CLAROS_DASHBOARD_DIST) return { distPath: process.env.CLAROS_DASHBOARD_DIST, mechanism: "env" };
  const __filename = fileURLToPath(import.meta.url);
  const monoRoot = path.resolve(path.dirname(__filename), "../../..");
  return { distPath: path.join(monoRoot, "apps", "dashboard", "dist"), mechanism: "auto" };
}
