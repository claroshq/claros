/**
 * Invite acceptance routes - public (unauthenticated).
 *
 * Handles the invite acceptance flow, similar to the magic link verify flow:
 *   GET  /invite/accept?token=xxx - Interstitial confirmation page
 *   POST /invite/accept           - Consume invite, create user + session, redirect
 *
 * Security model mirrors magic link verify:
 *   - GET is side-effect free (interstitial page). Mail scanners cannot burn the token.
 *   - POST consumes the token atomically (CAS on accepted_at IS NULL).
 *   - Token is single-use. Second use gets redirected to login with error.
 *   - 7-day TTL.
 */
import { createHash } from "node:crypto";
import { setCookie } from "hono/cookie";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { createRouter, parseBody } from "../http/router.js";
import { parseForm } from "../http/body.js";

/** Session TTL: 30 days (same as normal login). */
const SESSION_TTL_DAYS = 30;

/** Cookie name for session ID (same as auth.ts). */
const SESSION_COOKIE_NAME = "claros_session";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the invite acceptance confirmation page.
 * Mirrors the magic link interstitial: standalone, branded, inline styles.
 */
function renderAcceptPage(email: string, tenantName: string, token: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Join ${escapeHtml(tenantName)} on Claros</title>
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
      <h1>Join ${escapeHtml(tenantName)}</h1>
      <p>You have been invited to join as <strong>${escapeHtml(email)}</strong>.</p>
      <form method="post" action="/invite/accept">
        <input type="hidden" name="token" value="${escapeHtmlAttr(token)}" />
        <button type="submit">Accept invitation</button>
      </form>
    </main>
  </body>
</html>`;
}

export interface InviteRouteOptions {
  dashboardUrl: string;
}

export default function inviteRoutes(opts: InviteRouteOptions) {
  const { dashboardUrl } = opts;
  const app = createRouter();

  // Form body parser for this scope (parseForm has the same semantics as the
  // v0.6 parser: "+" is a space, pairs without "=" are skipped).
  const body = parseBody({ parsers: { "application/x-www-form-urlencoded": parseForm } });

  /**
   * GET /invite/accept?token=xxx
   * Interstitial confirmation page. Does NOT consume the token.
   */
  app.get(
    "/accept",
    async (c) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_invite`;

      const token = c.req.query("token");
      if (!token || token.length === 0) {
        return c.redirect(failRedirect, 302);
      }

      const db: Db = c.var.db;
      const tokenHash = hashToken(token);

      // Read-only lookup
      const row = await storeFor(db).apiInvite.findInviteByTokenHash(tokenHash);
      if (!row || row.acceptedAt !== null || row.expiresAt < new Date()) {
        return c.redirect(failRedirect, 302);
      }

      // Get tenant name for the interstitial
      const tenantName = (await storeFor(db).apiInvite.findTenantName(row.tenantId)) ?? "this workspace";

      return c.html(renderAcceptPage(row.email, tenantName, token), 200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
    },
  );

  /**
   * POST /invite/accept
   * Consume the invite, create user, create session, redirect to dashboard.
   */
  app.post(
    "/accept",
    body,
    async (c) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_invite`;

      const token = (c.var.body as { token?: string } | undefined)?.token;
      if (!token || token.length === 0) {
        return c.redirect(failRedirect, 302);
      }

      const db: Db = c.var.db;
      const tokenHash = hashToken(token);
      const now = new Date();

      // Atomic CAS: consume the invite only if not yet consumed
      const invite = await storeFor(db).apiInvite.consumeInvite({ tokenHash, now });

      if (!invite) {
        return c.redirect(failRedirect, 302);
      }

      // Check expiry (mark consumed regardless to prevent reuse)
      if (invite.expiresAt < now) {
        return c.redirect(failRedirect, 302);
      }

      // Check if a user with this email already exists (reactivation or collision)
      const existingUser = await storeFor(db).apiInvite.findUserByEmail({
        tenantId: invite.tenantId,
        email: invite.email,
      });

      let userId: string;

      // A user whose home is another product joins this one by membership
      // (one user row per person, one login).
      const elsewhere = existingUser
        ? null
        : await storeFor(db).apiInvite.findActiveUserElsewhere({
            tenantId: invite.tenantId,
            email: invite.email,
          });

      if (existingUser) {
        // Reactivate a previously deactivated user (and restore their membership)
        userId = existingUser.id;
        await storeFor(db).apiInvite.reactivateUser({
          userId,
          tenantId: invite.tenantId,
          role: invite.role,
          now,
        });
      } else if (elsewhere) {
        userId = elsewhere.id;
        await storeFor(db).apiInvite.addMembership({
          userId,
          tenantId: invite.tenantId,
          role: invite.role,
          now,
        });
      } else {
        // Create new user (and its membership)
        userId = await storeFor(db).apiInvite.createUser({
          tenantId: invite.tenantId,
          email: invite.email,
          role: invite.role,
          now,
        });
      }

      // Create session
      const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      const sessionId = await storeFor(db).apiInvite.createSession({
        tenantId: invite.tenantId,
        userId,
        expiresAt: sessionExpiresAt,
      });

      // Set session cookie
      setCookie(c, SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
      });

      return c.redirect(`${dashboardUrl}/`, 302);
    },
  );

  return app;
}
