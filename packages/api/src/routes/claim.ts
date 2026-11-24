/**
 * Claim route - first-account creation for fresh installs.
 *
 * When no users exist, the server logs a one-time claim URL at startup.
 * GET /claim?token=<token> renders a form where the installer enters their
 * email. POST /claim consumes the token, creates the owner, and signs them in.
 *
 * Design decisions:
 * - Token is stored in memory only (never persisted), regenerated on each restart.
 *   Justification: nothing is claimed yet so no state to lose; latest logs win.
 * - Single-use: consumed on successful POST, set to null in the closure.
 *   Justification: the first person to reach the URL becomes the owner;
 *   concurrent requests race on the DB insert (ON CONFLICT catches it).
 * - No expiry while zero users: a 10-minute TTL would strand the installer
 *   (recovery is "restart the container and read the new URL").
 * - After an owner exists: GET /claim returns a redirect to /login regardless
 *   of token validity. The claim surface disappears entirely once claimed.
 */
import type { FastifyPluginAsync } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { users, tenants, sessions } from "@claros/db/schema";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import { SESSION_COOKIE_NAME } from "./auth.js";

const SESSION_TTL_DAYS = 30;

interface ClaimRouteOptions {
  /** The in-memory claim token. Null means claim is not active. */
  getClaimToken: () => string | null;
  /** Consume the token after successful claim. */
  consumeClaimToken: () => void;
  /** Dashboard URL for post-claim redirect. */
  dashboardUrl: string;
}

const claimRoutes: FastifyPluginAsync<ClaimRouteOptions> = async (app, opts) => {
  const { getClaimToken, consumeClaimToken, dashboardUrl } = opts;

  // Scoped form body parser for the claim POST (application/x-www-form-urlencoded).
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const parsed: Record<string, string> = {};
        for (const pair of (body as string).split("&")) {
          const [k, v] = pair.split("=");
          if (k) parsed[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
        }
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * GET /claim?token=<token>
   * Renders a minimal HTML form for entering the owner email.
   * If users already exist, redirects to /login.
   */
  app.get<{ Querystring: { token?: string } }>("/", async (request, reply) => {
    const db: Db = request.server.db;

    // If any user exists, claim is over.
    const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length > 0) {
      reply.redirect(`${dashboardUrl}/login`);
      return;
    }

    const token = request.query.token;
    const validToken = getClaimToken();
    if (!token || !validToken || token !== validToken) {
      reply.status(403).type("text/html").send(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid claim link</h1>
          <p>This link is invalid or has expired. Each server instance generates
          its own claim URL at startup. If you are running multiple instances
          behind a load balancer, the request may have reached a different
          instance than the one that printed the URL.</p>
          <p>Fix: scale to one instance for the initial claim, or check the logs
          of the instance that received this request.</p>
          <pre>docker compose logs app | grep "claim"</pre>
        </body></html>
      `);
      return;
    }

    reply.type("text/html").send(`
      <!doctype html>
      <html><head><title>Claim your Claros account</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; }
        input { display: block; width: 100%; padding: 10px; margin: 12px 0; font-size: 16px; border: 1px solid #ccc; border-radius: 6px; }
        button { padding: 10px 24px; font-size: 16px; background: #111; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
        button:hover { background: #333; }
      </style>
      </head>
      <body>
        <h1>Claim your account</h1>
        <p>Enter your email to become the owner of this Claros instance. This is a one-time action.</p>
        <form method="POST" action="/claim">
          <input type="hidden" name="token" value="${token}" />
          <label for="email">Your email address</label>
          <input type="email" id="email" name="email" required placeholder="you@company.com" autofocus />
          <button type="submit">Create owner account</button>
        </form>
      </body></html>
    `);
  });

  /**
   * POST /claim
   * Consumes the claim token, creates the owner user, starts a session.
   */
  app.post<{ Body: { token?: string; email?: string } }>("/", async (request, reply) => {
    const db: Db = request.server.db;

    // If any user exists, claim is over.
    const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length > 0) {
      reply.redirect(`${dashboardUrl}/login`);
      return;
    }

    // Parse form body (application/x-www-form-urlencoded)
    const body = request.body as Record<string, string> | undefined;
    const token = body?.token;
    const email = body?.email?.toLowerCase().trim();

    const validToken = getClaimToken();
    if (!token || !validToken || token !== validToken) {
      reply.status(403).type("text/html").send(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid or expired token</h1>
          <p>This claim link is no longer valid. Check the latest container logs for the current URL.</p>
        </body></html>
      `);
      return;
    }

    if (!email || !email.includes("@") || email.length < 3) {
      reply.status(400).type("text/html").send(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid email</h1>
          <p>Please provide a valid email address.</p>
          <a href="javascript:history.back()">Go back</a>
        </body></html>
      `);
      return;
    }

    // Find the default tenant (created by bootstrapSeed).
    const tenantRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "default"))
      .limit(1);

    if (tenantRows.length === 0) {
      reply.status(500).type("text/html").send(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Setup error</h1>
          <p>No tenant found. The server may not have completed bootstrap.</p>
        </body></html>
      `);
      return;
    }

    const tenantId = tenantRows[0]!.id;

    // Create the owner user.
    const [newUser] = await db
      .insert(users)
      .values({ tenantId, email, role: "owner" })
      .onConflictDoNothing()
      .returning({ id: users.id });

    if (!newUser) {
      // Race condition: another request created a user. Redirect to login.
      reply.redirect(`${dashboardUrl}/login`);
      return;
    }

    // Consume the claim token (single-use).
    consumeClaimToken();

    // Create a session and sign the user in.
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [session] = await db
      .insert(sessions)
      .values({ tenantId, userId: newUser.id, expiresAt })
      .returning({ id: sessions.id });

    reply.setCookie(SESSION_COOKIE_NAME, session!.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    // Redirect to the dashboard.
    reply.redirect(`${dashboardUrl}/`);
  });
};

export default claimRoutes;
