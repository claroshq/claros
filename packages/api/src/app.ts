/**
 * HTTP app factory (Hono), runtime-neutral.
 *
 * Builds the Claros HTTP API. Called by apps/server (through the Node adapter
 * in ./node.ts) and by apps/worker (Cloudflare Workers). The external HTTP API
 * is the v0.6 API: same routes (tests/contract/v0.6-routes.txt), status codes,
 * bodies and framework error shapes.
 *
 * This module must not import Node-only modules (node:fs, node:path,
 * node:url, @hono/node-server): the Workers bundle imports it. Serving the
 * dashboard from disk and listening on a socket live in ./node.ts.
 *
 * Assembly:
 *   1. Context: db, enqueue, logger; session -> tenant resolution
 *   2. Public routes: health, version, auth, claim, unsubscribe, invite, webhooks, brand
 *   3. Dashboard routes under /v1 (session cookie + per-route minimum role)
 *   4. Ingestion routes under /v1 (API key auth, CORS)
 *   5. Static dashboard + SPA fallback (when the runtime provides one)
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { storeFor } from "@claros/store";

import type { AppEnv } from "./http/env.js";
import type { Db, EnqueueFn } from "./plugins/db.js";
import { resolveSession } from "./http/session.js";
import { bodyParser } from "./http/body.js";
import { frameworkError, notFound } from "./http/errors.js";
import { inject, type InjectOptions, type InjectResponse } from "./http/inject.js";
import { createLogger, type AppLogger, type LoggerOption } from "./http/logger.js";
import type { StaticFallback } from "./http/spa.js";
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
import importRoutes from "./routes/import.js";
import suppressionRoutes from "./routes/suppressions.js";
import templatesRoutes from "./routes/templates.js";
import messagesRoutes from "./routes/messages.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import ingestionRoutes from "./routes/ingestion.js";
import resendWebhookRoutes from "./routes/webhooks/resend.js";
import settingsRoutes from "./routes/settings.js";
import libraryRoutes from "./routes/library.js";
import emailTemplatesRoutes from "./routes/email-templates.js";
import layoutsRoutes from "./routes/layouts.js";
import eventsRoutes from "./routes/events.js";
import sentLogRoutes from "./routes/sent-log.js";
import teamRoutes from "./routes/team.js";
import profileRoutes from "./routes/profile.js";
import productsRoutes from "./routes/products.js";
import instanceRoutes from "./routes/instance.js";
import topicsRoutes from "./routes/topics.js";
import configRoutes from "./routes/config.js";
import capabilitiesRoutes from "./routes/capabilities.js";
import webhookEndpointRoutes from "./routes/webhook-endpoints.js";
import flowStepsRoutes from "./routes/flow-steps.js";
import { brandSettingsRoutes, publicBrandRoutes } from "./routes/brand.js";

export { API_PATH_PREFIXES } from "./http/spa.js";

export interface BuildAppOptions {
  /** Process role reported in /health. Defaults to "all". */
  role?: string;
  /**
   * Runtime reported by GET /v1/capabilities. Default: "node" on Postgres,
   * "workers" on D1. apps/worker passes "workers".
   */
  runtime?: "node" | "workers";
  /** Edition label reported in /health and /version. Always "community"; kept for v0.6 compatibility. */
  edition?: string;
  /** Logger: false silences, { level } configures, or pass an object with debug/info/warn/error. */
  logger?: LoggerOption;
  /** Drizzle database client. Most routes are registered only when it is provided. */
  db?: Db;
  /** Job enqueue function (pg-boss send on Node, a Queue send on Workers). */
  enqueue?: EnqueueFn;
  /** Base URL of the API (magic links, unsubscribe links). */
  baseUrl?: string;
  /** Dashboard URL for post-login redirects. Defaults to baseUrl. */
  dashboardUrl?: string;
  /**
   * Static dashboard + SPA fallback for requests no route matched, built from
   * the app's logger. Returns null to serve nothing (JSON 404). The Node
   * adapter (./node.ts) and apps/worker provide one; absent means no SPA.
   */
  staticFallback?: (log: AppLogger) => StaticFallback | null;
  /**
   * One-time claim token for the first account; claim routes exist only while
   * it is set. The token is checked against the claim_tokens table: the Node
   * server writes it there at boot, and the app writes it (hashed, 24 hour
   * expiry) on the first claim request when it is missing.
   */
  claimToken?: string | null;
  /**
   * Cloudflare Workers: mount the claim routes while no user exists, checked
   * per request (cached briefly per isolate). Tokens come from claim_tokens
   * (minted by the deploy CLI); the default product is created on claim.
   */
  claimFromDatabase?: boolean;
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
  /** Release the app's resources (the Node adapter stops its server). */
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
    app.route("/claim", claimRoutes({ dashboardUrl, seedToken: opts.claimToken }));
  } else if (opts.db && opts.claimFromDatabase) {
    const gate = claimGate();
    app.route(
      "/claim",
      claimRoutes({
        dashboardUrl,
        isOpen: gate.isOpen,
        onClaimed: gate.close,
        seedDefaultTenant: true,
        newLinkHint: "cli",
      }),
    );
  }

  if (opts.db) {
    app.route("/unsubscribe", unsubscribeRoutes());
    app.route("/invite", inviteRoutes({ dashboardUrl }));
    app.route("/webhooks/resend", resendWebhookRoutes());
    app.route("/brand", publicBrandRoutes());
  }

  // --- Dashboard routes (session cookie, per-route minimum role) --------------
  if (opts.db) {
    app.route("/v1/flows", flowsRoutes());
    app.route("/v1/flows", flowStepsRoutes());
    app.route("/v1/contacts", contactsRoutes());
    app.route("/v1/analytics", analyticsRoutes());
    app.route("/v1/kb", kbRoutes());
    app.route("/v1/import", importRoutes());
    app.route("/v1/suppressions", suppressionRoutes());
    app.route("/v1/templates", templatesRoutes());
    app.route("/v1/messages", messagesRoutes());
    app.route("/v1/settings/brand", brandSettingsRoutes({ baseUrl }));
    app.route("/v1/settings", settingsRoutes());
    app.route("/v1/ingestion", ingestionRoutes());
    app.route("/v1/library", libraryRoutes());
    app.route("/v1/email-templates", emailTemplatesRoutes());
    app.route("/v1/layouts", layoutsRoutes());
    app.route("/v1/events", eventsRoutes());
    app.route("/v1/sent-log", sentLogRoutes());
    app.route("/v1/team", teamRoutes());
    app.route("/v1/profile", profileRoutes());
    app.route("/v1/products", productsRoutes());
    app.route("/v1/instance", instanceRoutes());
    app.route("/v1/topics", topicsRoutes());
    app.route("/v1/config", configRoutes());
    app.route("/v1/capabilities", capabilitiesRoutes({ runtime: opts.runtime }));
    app.route("/v1/webhooks", webhookEndpointRoutes());
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

  const spa = opts.staticFallback ? opts.staticFallback(log) : null;
  // v0.6 parsed the body before answering 404, so a broken body on an
  // unknown route still got the 400/413/415 parse error.
  const notFoundBody = bodyParser();
  app.notFound(async (c) => {
    const parseError = await notFoundBody(c as Context<AppEnv>, async () => {});
    if (parseError instanceof Response) return parseError;
    return spa ? spa(c as Context<AppEnv>) : notFound(c);
  });

  // --- Wrapper -----------------------------------------------------------------
  return {
    hono: app,
    log,
    fetch: (request) => app.fetch(request),
    inject: (o) => inject(app, o),
    ready: async () => {},
    close: async () => {},
    routes: () => listRoutes(app),
  };
}

/** How long "no user exists yet" is trusted before the claim gate asks again. */
const CLAIM_GATE_TTL_MS = 5_000;

/**
 * The claim routes are open while no user exists. Once a user exists the
 * answer never changes back, so it is kept for the life of the isolate; the
 * "still open" answer is re-checked every few seconds.
 */
function claimGate(): { isOpen: (db: Db) => Promise<boolean>; close: () => void } {
  let closed = false;
  let openUntil = 0;
  return {
    async isOpen(db) {
      if (closed) return false;
      if (Date.now() < openUntil) return true;
      if (await storeFor(db).apiClaim.anyUserExists()) {
        closed = true;
        return false;
      }
      openUntil = Date.now() + CLAIM_GATE_TTL_MS;
      return true;
    },
    close() {
      closed = true;
    },
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
