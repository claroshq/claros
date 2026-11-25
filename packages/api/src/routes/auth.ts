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
import { z } from "zod";
import { getCookie, setCookie } from "hono/cookie";
import { storeFor } from "@claros/store";
import {
  resolveTransportAdapter,
  type TransportAdapter,
} from "@claros/adapters";
import { buildLoginEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";
import { createRouter, parseBody } from "../http/router.js";
import { parseForm } from "../http/body.js";
import { validateBody, validateQuery } from "../http/validate.js";
import { SESSION_COOKIE_NAME } from "../http/session.js";
import type { AppContext } from "../http/env.js";

/** Cookie name for session ID (defined in http/session.ts, re-exported here). */
export { SESSION_COOKIE_NAME } from "../http/session.js";

/** Token TTL in minutes. */
const TOKEN_TTL_MINUTES = 10;

/** Session TTL in days. */
const SESSION_TTL_DAYS = 30;

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
   * to the API server.
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
  const row = await storeFor(db).apiAuth.findActiveTransportConfig(tenantId);
  if (!row) return null;

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

// ---------------------------------------------------------------------------
// Request schemas (v0.6 validated these with Ajv: coerceTypes, ajv-formats "full")
// ---------------------------------------------------------------------------

/**
 * Ajv's email format ("full" mode, as registered by v0.6's validator).
 * Kept verbatim so the accepted set of addresses does not change.
 */
const AJV_EMAIL_FORMAT =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** A string field with Ajv's scalar coercion (number/boolean -> string, null -> ""). */
function ajvString<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v === null ? "" : v),
    inner,
  );
}

const loginBodySchema = z.object({
  email: ajvString(
    z
      .string({ invalid_type_error: "must be string" })
      .regex(AJV_EMAIL_FORMAT, { message: 'must match format "email"' }),
  ),
});

const verifyQuerySchema = z.object({
  token: ajvString(z.string({ invalid_type_error: "must be string" })).optional(),
});

const verifyBodySchema = z.object({
  token: ajvString(z.string({ invalid_type_error: "must be string" })).optional(),
});

/** Session cookie attributes (unchanged since v0.6). */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60, // seconds
  };
}

/** Clear the session cookie the way v0.6 did (empty value, epoch Expires, path /). */
function clearSessionCookie(c: AppContext): void {
  setCookie(c, SESSION_COOKIE_NAME, "", { path: "/", expires: new Date(0) });
}

export default function authRoutes(opts: AuthRouteOptions) {
  const { baseUrl, dashboardUrl } = opts;
  const app = createRouter();

  // Form body parser for this scope (needed for the interstitial form POST to
  // /auth/verify). Same manual parser as unsubscribe.ts (parseForm has the
  // identical semantics) - no new dependency. JSON uses the default parser.
  const body = parseBody({ parsers: { "application/x-www-form-urlencoded": parseForm } });

  /**
   * POST /auth/login
   * Request a magic link. Body: { email: string }
   *
   * Always returns 200 with a generic message regardless of whether the email
   * exists (prevents user enumeration). If the user does not exist, no token
   * is created and no link is sent/printed.
   */
  // v0.6 declared a 200 response schema with only `message`; every return
  // below sends exactly that field.
  app.post(
    "/login",
    body,
    async (c) => {
      const v = validateBody(c, loginBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const { email } = v.value;
      const normalizedEmail = email.toLowerCase().trim();

      // Look up user by email (across all tenants for login - user belongs to exactly one tenant)
      const user = await storeFor(db).apiAuth.findUserByEmail(normalizedEmail);

      if (!user) {
        // User not found - return generic response to prevent enumeration.
        // Log for debugging but do not reveal to client.
        c.var.log.debug({ email: normalizedEmail }, "Login attempt for unknown email");
        return c.json({ message: "If that email is registered, a login link has been sent." });
      }

      // Generate token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

      // Store token hash in DB
      await storeFor(db).apiAuth.createMagicLinkToken({
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
      // forwards /auth/* to the API server - so the link is clickable in a browser.
      // In self-host mode both values are the same origin.
      const loginUrl = `${dashboardUrl}/auth/verify?token=${raw}`;

      // Check if tenant has a configured transport
      const hasTransport = await storeFor(db).apiAuth.hasActiveTransport(user.tenantId);

      if (!hasTransport && isConsoleLoginAllowed()) {
        // Console fallback: print the login URL to server logs.
        // This path only fires in non-production environments.
        c.var.log.info(
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

        return c.json({ message: "Login link printed to server console." });
      }

      if (!hasTransport && !isConsoleLoginAllowed()) {
        // Production with no transport: cannot send or print the link.
        // This should not happen in Cloud (transport always exists).
        // Log as error for operator visibility.
        c.var.log.error(
          { email: normalizedEmail, tenantId: user.tenantId },
          "Cannot send login link: no transport configured and console fallback is disabled",
        );
        return c.json({ message: "If that email is registered, a login link has been sent." });
      }

      // Has transport: attempt to send the login link via email.
      // This is transactional auth email - bypasses drain, throttle, suppression,
      // and compliance headers. See resolveAuthTransport() for reasoning.
      const transport = await resolveAuthTransport(db, user.tenantId);

      // Resolve brand settings for the branded email shell
      const tenantRow = await storeFor(db).apiAuth.findTenantBrand(user.tenantId);
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
            c.var.log.info(
              { email: normalizedEmail },
              "Login link sent via email",
            );
            return c.json({ message: "If that email is registered, a login link has been sent." });
          }

          // Send failed - fall through to console fallback below.
          c.var.log.warn(
            { email: normalizedEmail, error: result.error, permanent: result.permanent },
            "Login link email send failed, falling back to console",
          );
        } catch (err) {
          // Unexpected error (network, etc.) - fall through to console fallback.
          c.var.log.warn(
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
        return c.json({ message: "Login link printed to server console." });
      }

      return c.json({ message: "If that email is registered, a login link has been sent." });
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
  app.get(
    "/verify",
    async (c) => {
      const q = validateQuery(c, verifyQuerySchema);
      if (!q.ok) return q.response;
      const db: Db = c.var.db;
      const failRedirect = `${dashboardUrl}/login?error=invalid_link`;

      const { token } = q.value;

      if (!token || token.length === 0) {
        return c.redirect(failRedirect, 302);
      }

      const tokenHash = hashToken(token);

      // Read-only lookup. Consumption happens exclusively in the POST handler.
      const now = new Date();
      const row = await storeFor(db).apiAuth.findMagicLinkToken(tokenHash);
      if (!row || row.consumedAt !== null || row.expiresAt < now) {
        return c.redirect(failRedirect, 302);
      }

      // The page is per-token and short-lived; never let a scanner cache it.
      return c.html(renderVerifyPage(row.email, token), 200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
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
  app.post(
    "/verify",
    body,
    async (c) => {
      const v = validateBody(c, verifyBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const failRedirect = `${dashboardUrl}/login?error=invalid_link`;

      const token = v.value.token;

      if (!token || token.length === 0) {
        return c.redirect(failRedirect, 302);
      }

      const tokenHash = hashToken(token);

      // Atomic CAS: consume the token only if it has not been consumed yet.
      // This ensures single-use even under concurrent requests.
      const now = new Date();
      const tokenRow = await storeFor(db).apiAuth.consumeMagicLinkToken({ tokenHash, now });

      if (!tokenRow) {
        // Token not found, already consumed, or tampered.
        return c.redirect(failRedirect, 302);
      }

      // Check expiry
      if (tokenRow.expiresAt < now) {
        // Token was consumed but is expired. Already marked consumed so it
        // cannot be reused regardless.
        return c.redirect(failRedirect, 302);
      }

      // Create session
      const sessionExpiresAt = new Date(
        Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      const sessionId = await storeFor(db).apiAuth.createSession({
        tenantId: tokenRow.tenantId,
        userId: tokenRow.userId,
        expiresAt: sessionExpiresAt,
      });

      // Set session cookie before the redirect so the browser sends it on the
      // first request to the dashboard.
      setCookie(c, SESSION_COOKIE_NAME, sessionId, sessionCookieOptions());

      // Update user's last_login_at
      await storeFor(db).apiAuth.touchUserLastLogin({ userId: tokenRow.userId, now });

      return c.redirect(`${dashboardUrl}/`, 302);
    },
  );

  /**
   * POST /auth/logout
   * Destroy the current session.
   */
  app.post("/logout", body, async (c) => {
    const db: Db = c.var.db;
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      await storeFor(db).apiAuth.deleteSession(sessionId);
    }

    clearSessionCookie(c);
    return c.json({ message: "Logged out." });
  });

  /**
   * GET /auth/me
   * Get the current authenticated user. Returns 401 if not logged in.
   */
  app.get("/me", async (c) => {
    const db: Db = c.var.db;
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) {
      return c.json({ error: "Not authenticated." }, 401);
    }

    const session = await storeFor(db).apiAuth.findSession(sessionId);

    if (!session || session.expiresAt < new Date()) {
      clearSessionCookie(c);
      return c.json({ error: "Not authenticated." }, 401);
    }

    const user = await storeFor(db).apiAuth.findUserById(session.userId);

    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: "Not authenticated." }, 401);
    }

    // The product the request acts on (X-Claros-Product, else the session's
    // tenant) and the user's role there, when the session resolved one.
    const product = c.var.tenant?.userId === user.id ? c.var.tenant : null;

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: product?.userRole ?? user.role,
        tenantId: product?.id ?? session.tenantId,
      },
    });
  });

  return app;
}
