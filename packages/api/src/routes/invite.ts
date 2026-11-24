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
import type { FastifyPluginAsync } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { invites, users, sessions, tenants } from "@claros/db/schema";
import type { Db } from "../plugins/db.js";

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

const inviteRoutes: FastifyPluginAsync<InviteRouteOptions> = async (app, opts) => {
  const { dashboardUrl } = opts;

  // Register form body parser for this scope
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
   * GET /invite/accept?token=xxx
   * Interstitial confirmation page. Does NOT consume the token.
   */
  app.get<{ Querystring: { token?: string } }>(
    "/accept",
    async (request, reply) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_invite`;

      const { token } = request.query;
      if (!token || token.length === 0) {
        return reply.redirect(failRedirect, 302);
      }

      const db: Db = request.server.db;
      const tokenHash = hashToken(token);

      // Read-only lookup
      const rows = await db
        .select({
          email: invites.email,
          expiresAt: invites.expiresAt,
          acceptedAt: invites.acceptedAt,
          tenantId: invites.tenantId,
        })
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .limit(1);

      const row = rows[0];
      if (!row || row.acceptedAt !== null || row.expiresAt < new Date()) {
        return reply.redirect(failRedirect, 302);
      }

      // Get tenant name for the interstitial
      const tenantRows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, row.tenantId))
        .limit(1);
      const tenantName = tenantRows[0]?.name ?? "this workspace";

      return reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(renderAcceptPage(row.email, tenantName, token));
    },
  );

  /**
   * POST /invite/accept
   * Consume the invite, create user, create session, redirect to dashboard.
   */
  app.post<{ Body: { token?: string } }>(
    "/accept",
    async (request, reply) => {
      const failRedirect = `${dashboardUrl}/login?error=invalid_invite`;

      const token = request.body?.token;
      if (!token || token.length === 0) {
        return reply.redirect(failRedirect, 302);
      }

      const db: Db = request.server.db;
      const tokenHash = hashToken(token);
      const now = new Date();

      // Atomic CAS: consume the invite only if not yet consumed
      const consumed = await db
        .update(invites)
        .set({ acceptedAt: now })
        .where(
          and(
            eq(invites.tokenHash, tokenHash),
            isNull(invites.acceptedAt),
          ),
        )
        .returning({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          tenantId: invites.tenantId,
          expiresAt: invites.expiresAt,
        });

      if (consumed.length === 0) {
        return reply.redirect(failRedirect, 302);
      }

      const invite = consumed[0]!;

      // Check expiry (mark consumed regardless to prevent reuse)
      if (invite.expiresAt < now) {
        return reply.redirect(failRedirect, 302);
      }

      // Check if a user with this email already exists (reactivation or collision)
      const existingUser = await db
        .select({ id: users.id, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(and(eq(users.tenantId, invite.tenantId), eq(users.email, invite.email)))
        .limit(1);

      let userId: string;

      if (existingUser.length > 0) {
        // Reactivate a previously deactivated user
        userId = existingUser[0]!.id;
        await db
          .update(users)
          .set({ deactivatedAt: null, role: invite.role, lastLoginAt: now })
          .where(eq(users.id, userId));
      } else {
        // Create new user
        const [newUser] = await db
          .insert(users)
          .values({
            tenantId: invite.tenantId,
            email: invite.email,
            role: invite.role,
            lastLoginAt: now,
          })
          .returning({ id: users.id });
        userId = newUser!.id;
      }

      // Create session
      const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      const [session] = await db
        .insert(sessions)
        .values({
          tenantId: invite.tenantId,
          userId,
          expiresAt: sessionExpiresAt,
        })
        .returning({ id: sessions.id });

      // Set session cookie
      reply.setCookie(SESSION_COOKIE_NAME, session!.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
      });

      return reply.redirect(`${dashboardUrl}/`, 302);
    },
  );
};

export default inviteRoutes;
