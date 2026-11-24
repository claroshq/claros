/**
 * Fastify app factory.
 *
 * Builds and returns a configured Fastify instance. Called by apps/server
 * when the role includes API (role=all or role=api). Not called when the
 * process runs as a pure worker or scheduler.
 *
 * Plugin registration order:
 *   1. Cookie parser (required for session handling)
 *   2. Database decoration (app.db)
 *   3. Tenant resolution (request.tenant via session cookie)
 *   4. Public routes (health, auth - no auth required)
 *   5. Authenticated scope /v1 (all routes that require a resolved tenant)
 *   6. Ingestion scope /v1 (API key auth)
 *   7. Static serving + SPA fallback (LAST; only when opts.serveDashboard is true)
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { registerDbPlugin, type Db } from "./plugins/db.js";
import { registerTenantPlugin } from "./plugins/tenant.js";
import { registerRoleEnforcement } from "./plugins/role-enforcement.js";
import { registerIngestAuthPlugin } from "./plugins/ingest-auth.js";
import { registerIngestCorsPlugin } from "./plugins/ingest-cors.js";
import healthRoute from "./routes/health.js";
import versionRoute from "./routes/version.js";
import diagnosticsRoute from "./routes/diagnostics.js";
import authRoutes from "./routes/auth.js";
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
import resendWebhookRoute from "./routes/webhooks/resend.js";
import settingsRoutes from "./routes/settings.js";
import libraryRoutes from "./routes/library.js";
import emailTemplatesRoutes from "./routes/email-templates.js";
import eventsRoutes from "./routes/events.js";
import sentLogRoutes from "./routes/sent-log.js";
import teamRoutes from "./routes/team.js";
import profileRoutes from "./routes/profile.js";

/**
 * Top-level path prefixes that are owned by API routes.
 * The SPA fallback must never intercept these paths and serve index.html.
 * A GET to /v1/unknown should return a normal 404, not the SPA shell.
 * Derived from the route registrations below; update when new prefixes are added.
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
  /**
   * The process role: "all" | "api" | "worker" | "scheduler".
   * Supplied by apps/server from the --role argv flag.
   * Reported in /health. Defaults to "all".
   */
  role?: string;
  /**
   * Edition label reported in /health and /version. Always "community";
   * kept for v0.6 API compatibility.
   */
  edition?: string;
  /** Fastify logger config. Defaults to structured in production, disabled in test. */
  logger?: FastifyServerOptions["logger"];
  /**
   * Drizzle database client. Created by apps/server and passed here.
   * Required for auth, tenant resolution, and all data routes.
   * In tests, this can be a mock or an in-memory DB.
   */
  db?: Db;
  /**
   * Base URL of the API server for link generation (magic link verify URL,
   * unsubscribe headers). No trailing slash. Defaults to http://localhost:{PORT}.
   * Do not use for dashboard redirects - use dashboardUrl for that.
   */
  baseUrl?: string;
  /**
   * Base URL of the dashboard SPA. Used by /auth/verify to redirect the browser
   * after login. No trailing slash. Defaults to baseUrl when absent.
   */
  dashboardUrl?: string;
  /**
   * Job enqueue function. Injected by apps/server when pg-boss is available.
   * Signature matches PgBoss.send() for the subset we need: queue name, data, options.
   * API routes use this to enqueue background jobs (e.g. flow compilation).
   * When absent (tests without pg-boss), routes that require enqueue return 503.
   */
  enqueue?: (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;
  /**
   * When true, register @fastify/static to serve the dashboard SPA from dist/
   * and add a SPA catch-all fallback for unknown paths.
   *
   * apps/server passes true unless CLAROS_SERVE_DASHBOARD="false". Defaults
   * to false in BuildAppOptions to preserve existing test behaviour that does not set serveDashboard.
   *
   * If set to true but the dist directory cannot be found, a startup warning
   * is logged and static serving is skipped rather than crashing.
   */
  serveDashboard?: boolean;
  /**
   * Explicit path to the dashboard dist directory. When absent the app
   * resolves it relative to this file's own location, which works both from
   * compiled output (dist/app.js) and under tsx --watch (src/app.ts).
   * Can also be set via CLAROS_DASHBOARD_DIST env var.
   */
  dashboardDist?: string;
  /**
   * One-time claim token for first-account creation. When non-null, the
   * /claim route is registered and accepts this token to create the first
   * owner. Generated by apps/server on each boot when zero users exist.
   * Set to null after consumption (single-use).
   */
  claimToken?: string | null;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const role = opts.role ?? "all";
  const edition = opts.edition ?? "community";
  const port = process.env.PORT ?? "3000";
  const baseUrl = opts.baseUrl ?? process.env.BASE_URL ?? `http://localhost:${port}`;
  const dashboardUrl = opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? baseUrl;

  const logger =
    opts.logger !== undefined
      ? opts.logger
      : process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" };

  const app = Fastify({
    logger,
    // Destroy keep-alive connections immediately when app.close() is called.
    //
    // Without this, any open keep-alive connection (for example the one held by
    // the Cloudflare Worker ingress, or the keep-warm cron ping) prevents
    // app.close() from resolving until the remote end closes it. The keep-warm
    // cron fires every 60 s and the Worker proxy maintains a persistent
    // connection, so without forceCloseConnections the app.close() call in the
    // shutdown sequence would hang for up to 60 s on every deploy.
    //
    // With forceCloseConnections: true, Fastify 4 calls
    // server.closeAllConnections() (Node 18.2+, available on Node 22 which this
    // project targets). This is cited from:
    //   packages/api/node_modules/fastify/fastify.js:455
    //   packages/api/node_modules/fastify/package.json ("version": "4.29.1")
    // The default (when omitted) auto-selects 'idle' if available, which closes
    // only idle keep-alive connections and would still hang on an active one.
    // 'true' (closeAllConnections) is the correct choice here.
    forceCloseConnections: true,
  });

  // --- Infrastructure plugins ------------------------------------------------

  // Cookie parser - required for session handling
  await app.register(cookie);

  // Database client decoration (app.db)
  if (opts.db) {
    registerDbPlugin(app, opts.db);
  }

  // Job enqueue function decoration (app.enqueue)
  if (opts.enqueue) {
    app.decorate("enqueue", opts.enqueue);
  }

  // Tenant resolution. Validates session cookie, resolves request.tenant.
  // Must be registered on root instance, before any routes.
  registerTenantPlugin(app);

  // --- Public routes ---------------------------------------------------------

  // /health: always registered, no auth required. Compose smoke-test target.
  await app.register(healthRoute, { role, edition });

  // /version: always registered, no auth required, no DB access.
  // Returns build provenance: commit SHA (from CLAROS_COMMIT_SHA env), edition,
  // and image build timestamp (from CLAROS_BUILT_AT env). Used by `claros doctor`
  // to compare local HEAD against the running container without SSH access.
  await app.register(versionRoute, { edition });

  // /auth/*: magic link login, verify, logout, me. No auth required for login/verify.
  if (opts.db) {
    await app.register(authRoutes, { prefix: "/auth", baseUrl, dashboardUrl });
  }

  // /claim: first-account creation. Only active when claimToken is provided
  // (i.e., when zero users exist on this boot).
  if (opts.db && opts.claimToken != null) {
    let activeClaimToken: string | null = opts.claimToken;
    await app.register(
      (await import("./routes/claim.js")).default,
      {
        prefix: "/claim",
        getClaimToken: () => activeClaimToken,
        consumeClaimToken: () => { activeClaimToken = null; },
        dashboardUrl,
      },
    );
  }

  // /unsubscribe/*: public one-click (RFC 8058) + browser unsubscribe page.
  // No authentication. Token carries tenant + contact by ID; email resolved server-side.
  if (opts.db) {
    await app.register(unsubscribeRoutes, { prefix: "/unsubscribe" });
  }

  // /invite/*: public invite acceptance flow (interstitial + accept).
  // No authentication - the invitee is not yet a user.
  if (opts.db) {
    await app.register(inviteRoutes, { prefix: "/invite", dashboardUrl });
  }

  // /webhooks/resend/:tenantId: Resend provider webhook (bounces, opens, clicks, complaints).
  // Public, unauthenticated by session. Signature-verified via Svix/HMAC using
  // the per-tenant webhook secret stored in transport_configs. The tenant UUID
  // in the path is used to load the correct secret before the body is verified.
  if (opts.db) {
    await app.register(resendWebhookRoute, { prefix: "/webhooks/resend" });
  }

  // --- Authenticated scope (dashboard) ----------------------------------------
  // All routes that require a resolved tenant go here, under the /v1 prefix.
  // A preHandler rejects requests where request.tenant is null (returning 401).
  // This scope uses SESSION COOKIE authentication only.
  //
  // Route registrations are added as tasks are implemented:
  //   v1.register(contactsRoutes,  { prefix: "/contacts" });   // contacts ✓
  //   v1.register(flowsRoutes,     { prefix: "/flows" });       // task 10 ✓
  //   v1.register(kbRoutes,        { prefix: "/kb" });          // task 21 ✓
  //   v1.register(messagesRoutes,  { prefix: "/messages" });    // task 40 (partial) ✓
  //   v1.register(templatesRoutes, { prefix: "/templates" });   // task 25 ✓
  //   v1.register(analyticsRoutes, { prefix: "/analytics" }); // analytics ✓
  await app.register(
    async (v1) => {
      // Enforce authentication: reject requests without a resolved tenant.
      v1.addHook("preHandler", async (request, reply) => {
        if (request.tenant === null) {
          reply.status(401);
          reply.send({ error: "Authentication required." });
        }
      });

      // Role enforcement: every route must declare config.minRole.
      // Boot fails if any route omits it. Request-time check returns 403
      // when the user's role does not meet the route's declared minimum.
      registerRoleEnforcement(v1);

      // task 10: flow CRUD (dashboard operators only)
      if (opts.db) {
        await v1.register(flowsRoutes, { prefix: "/flows" });
      }

      // contacts: People list, person detail, merged timeline
      if (opts.db) {
        await v1.register(contactsRoutes, { prefix: "/contacts" });
      }

      // analytics: lifecycle distribution/movement + sending performance
      if (opts.db) {
        await v1.register(analyticsRoutes, { prefix: "/analytics" });
      }

      // task 21: knowledge base CRUD (dashboard operators only)
      if (opts.db) {
        await v1.register(kbRoutes, { prefix: "/kb" });
      }

      // task 24: suppression list import + list (dashboard operators only)
      if (opts.db) {
        await v1.register(suppressionRoutes, { prefix: "/suppressions" });
      }

      // task 25: business model templates (dashboard operators only)
      if (opts.db) {
        await v1.register(templatesRoutes, { prefix: "/templates" });
      }

      // task 40 (partial): message approval/rejection (dashboard operators only)
      if (opts.db) {
        await v1.register(messagesRoutes, { prefix: "/messages" });
      }

      // settings: transport configuration and tenant settings
      if (opts.db) {
        await v1.register(settingsRoutes, { prefix: "/settings" });
      }

      // ingestion: API key management + first-event status for the
      // Integrate screen (dashboard operators only)
      if (opts.db) {
        await v1.register(ingestionRoutes, { prefix: "/ingestion" });
      }

      // library: install pre-built flows and templates (no LLM required)
      if (opts.db) {
        await v1.register(libraryRoutes, { prefix: "/library" });
      }

      // email-templates: CRUD for email content templates (operator editing)
      if (opts.db) {
        await v1.register(emailTemplatesRoutes, { prefix: "/email-templates" });
      }

      // events: distinct event names for the flow editor autosuggest
      if (opts.db) {
        await v1.register(eventsRoutes, { prefix: "/events" });
      }

      // sent-log: sent-mail log for operators (what went out, to whom, when)
      if (opts.db) {
        await v1.register(sentLogRoutes, { prefix: "/sent-log" });
      }

      // team: invite, list, remove members, change roles (owner-only)
      if (opts.db) {
        await v1.register(teamRoutes, { prefix: "/team" });
      }

      // profile: view/edit own profile, email change
      if (opts.db) {
        await v1.register(profileRoutes, { prefix: "/profile" });
      }

      // /v1/diagnostics: authenticated env fingerprint check for `claros doctor`.
      // Session-cookie auth only (same preHandler as all /v1 routes).
      // Returns commit SHA, edition, and key fingerprints from the running container.
      // Never returns secret values.
      await v1.register(diagnosticsRoute, { prefix: "/diagnostics" });
    },
    { prefix: "/v1" },
  );

  // --- Ingestion scope (API key auth) ------------------------------------------
  // POST /v1/track and POST /v1/identify use BEARER TOKEN authentication,
  // completely separate from the session-cookie dashboard scope above.
  // A request carrying only a session cookie cannot reach these routes (the
  // ingest auth plugin rejects it). A request carrying only a bearer key
  // cannot reach the dashboard routes (the dashboard preHandler rejects it).
  // The CORS plugin in this scope emits Access-Control headers ONLY for
  // ingestion routes and never allows credentials (no cookies involved).
  if (opts.db) {
    await app.register(
      async (ingest) => {
        registerIngestCorsPlugin(ingest);
        registerIngestAuthPlugin(ingest);
        await ingest.register(ingestRoutes);
      },
      { prefix: "/v1" },
    );
  }

  // --- Static serving + SPA fallback (LAST) ------------------------------------
  // Registered when opts.serveDashboard is true.
  // Must come after all API routes to avoid shadowing them.
  if (opts.serveDashboard) {
    await registerSpaServing(app, opts);
  }

  return app;
}

/**
 * Register @fastify/static and the SPA index.html fallback.
 *
 * Separated into its own function to keep buildApp readable and to allow
 * testing the fallback logic in isolation.
 *
 * Path resolution strategy:
 *   1. opts.dashboardDist if provided
 *   2. CLAROS_DASHBOARD_DIST env var if set
 *   3. Resolved relative to this file: works under tsx --watch (src/)
 *      and from compiled output (dist/) because both are one level below
 *      packages/api/ and apps/dashboard/dist is always at a fixed
 *      path relative to the monorepo root.
 *
 * If the resolved path does not exist on disk, logs a warning and returns
 * without registering anything. This prevents a crash when starting the
 * server before running `npm run build -w @claros/dashboard`.
 */
async function registerSpaServing(
  app: FastifyInstance,
  opts: BuildAppOptions,
): Promise<void> {
  // Resolve the dist directory and record how it was resolved so the
  // warning message is immediately actionable without log archaeology.
  const { distPath, mechanism } = resolvedDashboardDist(opts);

  if (!existsSync(distPath)) {
    app.log.warn(
      `[dashboard] serveDashboard=true but dist directory not found. ` +
      `mechanism=${mechanism} tried=${distPath} -- ` +
      "If mechanism=auto, verify WORKDIR is the monorepo root or set CLAROS_DASHBOARD_DIST explicitly. " +
      "Run `npm run build -w @claros/dashboard` to create the dist directory. " +
      "Static serving and SPA fallback are disabled until the path exists.",
    );
    return;
  }

  // Serve hashed assets under /assets with a long immutable max-age.
  // Assets emitted by Vite contain a content hash in the filename so stale
  // cache entries are automatically busted on each deploy.
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: "/",
    // decorateReply defaults to true; reply.sendFile() is used by the
    // SPA fallback below. Do not set decorateReply: false.
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Hashed filenames - safe to cache for a year.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // index.html and other root files - must not be cached.
        res.setHeader("Cache-Control", "no-store");
      }
    },
  });

  // SPA fallback: serve index.html for any GET or HEAD request whose path
  // does not begin with an API prefix. Any other method (POST, PUT, etc.)
  // and any API-prefixed path fall through to Fastify's normal 404.
  app.setNotFoundHandler((request, reply) => {
    const method = request.method.toUpperCase();

    // Only GET and HEAD receive the SPA fallback.
    if (method !== "GET" && method !== "HEAD") {
      reply.status(404).send({ error: "Not Found" });
      return;
    }

    const pathname = request.url.split("?")[0] ?? "/";

    // Paths beginning with an API prefix must not serve index.html.
    // An unknown /v1/whatever should return a normal 404, not the SPA.
    const isApiPath = API_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (isApiPath) {
      reply.status(404).send({ error: "Not Found" });
      return;
    }

    // Serve index.html for all other GET/HEAD paths (SPA client-side routing).
    // Set no-store before sendFile so the header is included in the response.
    reply.header("Cache-Control", "no-store");
    reply.sendFile("index.html");
  });
}

/**
 * Resolve the absolute path to apps/dashboard/dist and the mechanism used.
 * Logic described in registerSpaServing above.
 *
 * Returns an object so callers can include the mechanism in log messages
 * without re-deriving it.
 */
export function resolvedDashboardDist(opts: BuildAppOptions): { distPath: string; mechanism: "opts" | "env" | "auto" } {
  if (opts.dashboardDist) return { distPath: opts.dashboardDist, mechanism: "opts" };
  if (process.env.CLAROS_DASHBOARD_DIST) return { distPath: process.env.CLAROS_DASHBOARD_DIST, mechanism: "env" };

  // Auto: resolve relative to this file. The layout is fixed:
  //   packages/api/src/app.ts  (tsx)   -> dirname = packages/api/src
  //   packages/api/dist/app.js (tsc)   -> dirname = packages/api/dist
  // Three ".." from dirname reaches the monorepo root in both cases:
  //   packages/api/src  -> .. -> packages/api -> .. -> packages -> .. -> <root>
  //   packages/api/dist -> .. -> packages/api -> .. -> packages -> .. -> <root>
  // apps/dashboard/dist is then a fixed path from that root.
  const __filename = fileURLToPath(import.meta.url);
  const monoRoot = path.resolve(path.dirname(__filename), "../../..");
  return { distPath: path.join(monoRoot, "apps", "dashboard", "dist"), mechanism: "auto" };
}
