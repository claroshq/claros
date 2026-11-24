/**
 * Auth routes - magic link login, verify, logout, session info.
 *
 * These routes are PUBLIC (registered outside the /v1 authenticated scope)
 * because the user is not yet authenticated when requesting or verifying a link.
 * Exception: /auth/logout and /auth/me require an active session.
 *
 * Security model:
 * - Token: 32 cryptographically random bytes, URL-safe base64.
 * - DB stores SHA-256(token); link carries the raw token.
 * - Single-use: atomic CAS (UPDATE WHERE consumed_at IS NULL).
 * - 10-minute TTL.
 * - Session: UUID in HTTP-only Secure SameSite=Lax cookie, 30-day fixed expiry.
 * - GET /auth/verify is side-effect free (interstitial confirm page) so mail
 *   scanner prefetch cannot burn the token; only POST /auth/verify consumes.
 *
 * Console fallback: when no transport is configured and NODE_ENV is not production
 * (and is not absent), the login link is printed to the server console instead of
 * being sent via email.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  users,
  sessions,
  magicLinkTokens,
  transportConfigs,
  tenants,
} from "@claros/db/schema";
import {
  resolveTransportAdapter,
  type TransportAdapter,
} from "@claros/adapters";
import { buildLoginEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";

/** Token TTL in minutes. */
const TOKEN_TTL_MINUTES = 10;

/** Session TTL in days. */
const SESSION_TTL_DAYS = 30;

/** Cookie name for session ID. */
export const SESSION_COOKIE_NAME = "claros_session";

/**
 * Generate a cryptographically random token (URL-safe base64).
 * Returns { raw, hash } where raw goes in the link, hash goes in the DB.
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/**
 * Hash a raw token for DB lookup.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Whether the console login fallback is allowed in this environment.
 *
 * Rules:
 * - NODE_ENV must be defined and not "production". Absence = closed.
 * - If NODE_ENV is "production", unconditionally OFF.
 * - If NODE_ENV is anything else ("development", "test"), ON.
 */
export function isConsoleLoginAllowed(): boolean {
  const env = process.env.NODE_ENV;
  if (env === undefined || env === "production") {
    return false;
  }
  return true;
}

export interface AuthRouteOptions {
  /**
   * Base URL of the API server (no trailing slash). Retained for interface
   * compatibility but not currently used in auth route logic. The magic link
   * verify URL is built from dashboardUrl (see below), not baseUrl, because
   * the dashboard may be served from a different host than the API (for
   * example behind a reverse proxy) and the Vite dev proxy forwards /auth/*
   * to Fastify.
   */
  baseUrl: string;
  /**
   * Base URL of the dashboard SPA (no trailing slash). Used for:
   *   - Building the magic link verify URL (/auth/verify?token=...)
   *   - Redirects after magic link verify:
   *     - Success: redirect to dashboardUrl/
   *     - Failure: redirect to dashboardUrl/login?error=invalid_link
   *
   * In self-host mode this is typically the same as baseUrl.
   * In Cloud it is the app. subdomain. Falls back to baseUrl when absent.
   */
  dashboardUrl: string;
}

// ---------------------------------------------------------------------------
// Magic link email delivery
// ---------------------------------------------------------------------------

/**
 * Resolve a TransportAdapter for a tenant. Returns { adapter, fromEmail, fromName }
 * or null if the tenant has no usable transport. This is a lightweight version of
 * the worker's transport-resolver, kept here because packages/api cannot import
 * from packages/worker (dependency direction: worker <- api, not the reverse).
 *
 * Why direct and not through the drain:
 *   A magic link is transactional authentication email initiated by the user.
 *   It must never be subject to the throttle gate (frequency caps, send windows)
 *   because suppressing a login email locks an operator out. It bypasses the drain
 *   entirely and calls the adapter directly.
 *
 * Why no compliance headers or footer:
 *   CAN-SPAM (16 CFR 316.3) distinguishes "commercial" from "transactional or
 *   relationship" messages. A magic link is a direct response to the recipient's
 *   own action (login request) with no commercial content. Transactional email
 *   does not require List-Unsubscribe, postal address footer, or opt-out mechanism.
 *   Adding an unsubscribe link to auth email would let a user permanently block
 *   their own login path, which is a lockout - not a compliance feature.
 *
 * Why suppression is bypassed:
 *   The suppression list blocks marketing email. A dashboard user who unsubscribed
 *   from lifecycle email (or whose address bounced from a lifecycle send) must still
 *   be able to log in. Authentication is not marketing. Suppressing auth email would
 *   create an unrecoverable lockout for the operator. Login links bypass suppression
 *   entirely. This is stated plainly: suppression does not apply to auth email.
 */
async function resolveAuthTransport(
  db: Db,
  tenantId: string,
): Promise<{ adapter: TransportAdapter; fromEmail: string; fromName: string | null } | null> {
  // Read active transport config
  const rows = await db.execute<{
    provider: string;
    config: string;
    from_email: string;
    from_name: string | null;
  }>(sql`
    SELECT provider, config::text AS config, from_email, from_name
    FROM transport_configs
    WHERE tenant_id = ${tenantId}::uuid
      AND is_active = true
    LIMIT 1
  `);

  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;

  // Delegate credential decryption + adapter construction to the shared function
  // in @claros/adapters. Same code path as the drain worker.
  const result = resolveTransportAdapter(row.provider, row.config);
  if (!result.ok) return null;

  return {
    adapter: result.transport.adapter,
    fromEmail: row.from_email,
    fromName: row.from_name,
  };
}

// ---------------------------------------------------------------------------
// Login email templates (branded via the shared email shell)
// ---------------------------------------------------------------------------

function buildLoginEmailHtml(loginUrl: string, _brand?: unknown): string {
  // Legacy fallback: called when brand context is not available.
  // Returns a minimal branded HTML through the shell with defaults.
  const { html } = buildLoginEmail(loginUrl, TOKEN_TTL_MINUTES, {
    brand: {},
    tenantName: "Claros",
  });
  return html;
}

function buildLoginEmailText(loginUrl: string): string {
  const { text } = buildLoginEmail(loginUrl, TOKEN_TTL_MINUTES, {
    brand: {},
    tenantName: "Claros",
  });
  return text;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Interstitial verify page
// ---------------------------------------------------------------------------

/**
 * Render the magic link confirmation page.
 *
 * Standalone HTML with inline styles: no external assets, so it renders
 * identically in any mail-client-adjacent browser context and does not
 * depend on the dashboard build. Values mirror the light-theme tokens in
 * apps/dashboard/src/index.css; the mark geometry mirrors
 * src/components/brand-mark.tsx.
 */
function renderVerifyPage(email: string, token: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Sign in to Claros</title>
    <style>
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f7f7f9; color: #26282e; font-family: system-ui, sans-serif; }
      main { width: 100%; max-width: 360px; padding: 24px; text-align: center; }
      h1 { font-size: 20px; font-weight: 600; margin: 16px 0 8px; }
      p { font-size: 14px; line-height: 1.6; color: #585d68; margin: 0 0 24px; }
      p strong { color: #26282e; font-weight: 500; }
      button { width: 100%; height: 40px; border: 0; border-radius: 6px; background: #26282e; color: #f7f7f9; font-size: 14px; font-weight: 500; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <g transform="translate(12 12) rotate(90)">
          <path d="M0 -10.8 C0 -10.8 -7.8 -2.5 -7.8 1.6 a7.8 7.8 0 0 0 15.6 0 C7.8 -2.5 0 -10.8 0 -10.8 Z M0 -2.4 a3.7 3.7 0 1 0 0.001 0 Z" fill="#008fba" fill-rule="evenodd" />
        </g>
      </svg>
      <h1>Sign in to Claros</h1>
      <p>You are signing in as <strong>${escapeHtml(email)}</strong>.</p>
      <form method="post" action="/auth/verify">
        <input type="hidden" name="token" value="${escapeHtmlAttr(token)}" />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, opts) => {
  const { baseUrl, dashboardUrl } = opts;
  const db: Db = app.db;

  // Register form body parser for this scope (needed for the interstitial
  // form POST to /auth/verify). Same manual parser as unsubscribe.ts - no
  // new dependency. JSON is handled by Fastify's built-in parser.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const parsed: Record<string, string> = {};
      if (typeof body === "string" && body.length > 0) {
        for (const pair of body.split("&")) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
          const value = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
          parsed[key] = value;
        }
      }
      done(null, parsed);
    },
  );

  /**
   * POST /auth/login
   * Request a magic link. Body: { email: string }
   *
   * Always returns 200 with a generic message regardless of whether the email
   * exists (prevents user enumeration). If the user does not exist, no token
   * is created and no link is sent/printed.
   */
  app.post<{ Body: { email: string } }>(
    "/login",
    {
      schema: {
        body: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const normalizedEmail = email.toLowerCase().trim();

      // Look up user by email (across all tenants for login - user belongs to exactly one tenant)
      const userRows = await db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (userRows.length === 0) {
        // User not found - return generic response to prevent enumeration.
        // Log for debugging but do not reveal to client.
        request.log.debug({ email: normalizedEmail }, "Login attempt for unknown email");
        return { message: "If that email is registered, a login link has been sent." };
      }

      const user = userRows[0]!;

      // Generate token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

      // Store token hash in DB
      await db.insert(magicLinkTokens).values({
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: hash,
        expiresAt,
      });

      // Build the magic link URL.
      // Resolution order: dashboardUrl (DASHBOARD_URL), then baseUrl (BASE_URL),
      // then http://localhost:PORT. dashboardUrl is resolved in app.ts with
      // opts.dashboardUrl ?? DASHBOARD_URL ?? baseUrl.
      // In Vite dev mode DASHBOARD_URL=http://localhost:5173 and the Vite proxy
      // forwards /auth/* to Fastify - so the link is clickable in a browser.
      // In self-host mode both values are the same origin.
      const loginUrl = `${dashboardUrl}/auth/verify?token=${raw}`;

      // Check if tenant has a configured transport
      const transports = await db
        .select({ id: transportConfigs.id })
        .from(transportConfigs)
        .where(
          and(
            eq(transportConfigs.tenantId, user.tenantId),
            eq(transportConfigs.isActive, true),
          ),
        )
        .limit(1);

      const hasTransport = transports.length > 0;

      if (!hasTransport && isConsoleLoginAllowed()) {
        // Console fallback: print the login URL to server logs.
        // This path only fires in non-production environments.
        request.log.info(
          { loginUrl, email: normalizedEmail },
          "CONSOLE LOGIN LINK (no transport configured)",
        );
        // Also print to stdout directly for docker compose logs visibility
        console.log("");
        console.log("========================================");
        console.log("  MAGIC LINK LOGIN (no email transport)");
        console.log("========================================");
        console.log(`  Email: ${normalizedEmail}`);
        console.log(`  URL:   ${loginUrl}`);
        console.log(`  Expires: ${TOKEN_TTL_MINUTES} minutes`);
        console.log("========================================");
        console.log("");

        return { message: "Login link printed to server console." };
      }

      if (!hasTransport && !isConsoleLoginAllowed()) {
        // Production with no transport: cannot send or print the link.
        // This should not happen in Cloud (transport always exists).
        // Log as error for operator visibility.
        request.log.error(
          { email: normalizedEmail, tenantId: user.tenantId },
          "Cannot send login link: no transport configured and console fallback is disabled",
        );
        return { message: "If that email is registered, a login link has been sent." };
      }

      // Has transport: attempt to send the login link via email.
      // This is transactional auth email - bypasses drain, throttle, suppression,
      // and compliance headers. See resolveAuthTransport() for reasoning.
      const transport = await resolveAuthTransport(db, user.tenantId);

      // Resolve brand settings for the branded email shell
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, user.tenantId))
        .limit(1);
      const tenantRow = tenantRows[0];
      const tenantSettings = (tenantRow?.settings as Record<string, unknown> | null) ?? {};
      const brand = (tenantSettings.brand as Record<string, unknown> | undefined) ?? {};
      const emailInput: TransactionalEmailInput = {
        brand: brand as TransactionalEmailInput["brand"],
        tenantName: tenantRow?.name ?? "Claros",
      };
      const { html: brandedHtml, text: brandedText } = buildLoginEmail(
        loginUrl, TOKEN_TTL_MINUTES, emailInput,
      );

      if (transport) {
        // Attempt direct send through the adapter (no drain, no throttle).
        // A unique message ID for idempotency - use the token hash (unique per request).
        const messageId = `auth-login-${hash}`;
        try {
          const result = await transport.adapter.send({
            to: normalizedEmail,
            from: transport.fromEmail,
            fromName: transport.fromName ?? undefined,
            subject: "Your login link",
            bodyHtml: brandedHtml,
            bodyText: brandedText,
            // No List-Unsubscribe, no compliance headers - transactional email.
            headers: {},
            messageId,
          });

          if (result.success) {
            // Email accepted by provider. Do NOT log the URL or token.
            request.log.info(
              { email: normalizedEmail },
              "Login link sent via email",
            );
            return { message: "If that email is registered, a login link has been sent." };
          }

          // Send failed - fall through to console fallback below.
          request.log.warn(
            { email: normalizedEmail, error: result.error, permanent: result.permanent },
            "Login link email send failed, falling back to console",
          );
        } catch (err) {
          // Unexpected error (network, etc.) - fall through to console fallback.
          request.log.warn(
            { email: normalizedEmail, error: err instanceof Error ? err.message : String(err) },
            "Login link email send threw, falling back to console",
          );
        }
      }

      // Fallback: transport not resolvable or send failed.
      // Print to console if allowed; otherwise return generic message.
      if (isConsoleLoginAllowed()) {
        console.log("");
        console.log("========================================");
        console.log("  MAGIC LINK LOGIN");
        console.log("========================================");
        console.log(`  Email: ${normalizedEmail}`);
        console.log(`  URL:   ${loginUrl}`);
        console.log(`  Expires: ${TOKEN_TTL_MINUTES} minutes`);
        console.log("========================================");
        console.log("");
        return { message: "Login link printed to server console." };
      }

      return { message: "If that email is registered, a login link has been sent." };
    },
  );

  /**
   * GET /auth/verify?token=xxx
   * Interstitial confirmation page. Does NOT consume the token and does NOT
   * create a session: corporate mail scanners and link preview fetchers GET
   * every URL in a message before the recipient clicks, and a GET with side
   * effects burns the single-use token (the user then lands on invalid_link).
   * A GET must be safe to prefetch; only the POST below has side effects.
   *
   * Valid token: 200 HTML page naming the account and a form whose button
   * POSTs the token back here. Scanners do not submit forms.
   * Invalid, consumed, or expired token: 302 -> dashboardUrl/login?error=invalid_link
   */
  app.get<{ Querystring: { token?: string } }>(
    "/verify",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { token: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_link`;

      const { token } = request.query;

      if (!token || token.length === 0) {
        return reply.redirect(failRedirect, 302);
      }

      const tokenHash = hashToken(token);

      // Read-only lookup. Consumption happens exclusively in the POST handler.
      const now = new Date();
      const rows = await db
        .select({
          expiresAt: magicLinkTokens.expiresAt,
          consumedAt: magicLinkTokens.consumedAt,
          email: users.email,
        })
        .from(magicLinkTokens)
        .innerJoin(users, eq(users.id, magicLinkTokens.userId))
        .where(eq(magicLinkTokens.tokenHash, tokenHash))
        .limit(1);

      const row = rows[0];
      if (!row || row.consumedAt !== null || row.expiresAt < now) {
        return reply.redirect(failRedirect, 302);
      }

      // The page is per-token and short-lived; never let a scanner cache it.
      return reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(renderVerifyPage(row.email, token));
    },
  );

  /**
   * POST /auth/verify
   * Consume a magic link token, create a session, set the cookie, redirect.
   * Body: application/x-www-form-urlencoded { token } (submitted by the
   * interstitial form; the token is the credential, so a cross-site form
   * cannot forge this).
   *
   * Success: 302 -> dashboardUrl/
   * Failure: 302 -> dashboardUrl/login?error=invalid_link
   *
   * The session cookie is set before the redirect so it is available on the
   * dashboard origin immediately after the browser follows the Location header.
   * Cookies set in a redirect response are sent by all major browsers.
   *
   * No JSON body is returned on either path.
   */
  app.post<{ Body: { token?: string } }>(
    "/verify",
    {
      schema: {
        body: {
          type: "object",
          properties: { token: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_link`;

      const token = request.body?.token;

      if (!token || token.length === 0) {
        return reply.redirect(failRedirect, 302);
      }

      const tokenHash = hashToken(token);

      // Atomic CAS: consume the token only if it has not been consumed yet.
      // This ensures single-use even under concurrent requests.
      const now = new Date();
      const consumed = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.consumedAt),
          ),
        )
        .returning({
          id: magicLinkTokens.id,
          userId: magicLinkTokens.userId,
          tenantId: magicLinkTokens.tenantId,
          expiresAt: magicLinkTokens.expiresAt,
        });

      if (consumed.length === 0) {
        // Token not found, already consumed, or tampered.
        return reply.redirect(failRedirect, 302);
      }

      const tokenRow = consumed[0]!;

      // Check expiry
      if (tokenRow.expiresAt < now) {
        // Token was consumed but is expired. Already marked consumed so it
        // cannot be reused regardless.
        return reply.redirect(failRedirect, 302);
      }

      // Create session
      const sessionExpiresAt = new Date(
        Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      const sessionRows = await db
        .insert(sessions)
        .values({
          tenantId: tokenRow.tenantId,
          userId: tokenRow.userId,
          expiresAt: sessionExpiresAt,
        })
        .returning({ id: sessions.id });

      const sessionId = sessionRows[0]!.id;

      // Set session cookie before the redirect so the browser sends it on the
      // first request to the dashboard.
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60, // seconds
      });

      // Update user's last_login_at
      await db
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, tokenRow.userId));

      return reply.redirect(`${dashboardUrl}/`, 302);
    },
  );

  /**
   * POST /auth/logout
   * Destroy the current session.
   */
  app.post("/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }

    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { message: "Logged out." };
  });

  /**
   * GET /auth/me
   * Get the current authenticated user. Returns 401 if not logged in.
   */
  app.get("/me", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const sessionRows = await db
      .select({
        userId: sessions.userId,
        tenantId: sessions.tenantId,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0 || sessionRows[0]!.expiresAt < new Date()) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const session = sessionRows[0]!;
    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (userRows.length === 0) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const user = userRows[0]!;
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: session.tenantId,
      },
    };
  });
};

export default authRoutes;
