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
import { randomBytes, createHash } from "node:crypto";
import { setCookie } from "hono/cookie";
import { users, tenants, sessions } from "@claros/db/schema";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import { SESSION_COOKIE_NAME } from "./auth.js";
import { createRouter, parseBody } from "../http/router.js";
import type { BodyParser } from "../http/body.js";

const SESSION_TTL_DAYS = 30;

interface ClaimRouteOptions {
  /** The in-memory claim token. Null means claim is not active. */
  getClaimToken: () => string | null;
  /** Consume the token after successful claim. */
  consumeClaimToken: () => void;
  /** Dashboard URL for post-claim redirect. */
  dashboardUrl: string;
}

/**
 * Scoped form body parser for the claim POST (application/x-www-form-urlencoded).
 * Differs from parseForm on purpose (v0.6 semantics): "+" is not decoded to a
 * space, a pair without "=" yields an empty value, and the value stops at the
 * second "=". A malformed escape throws, which answers 400.
 */
const parseClaimForm: BodyParser = (body) => {
  const parsed: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [k, v] = pair.split("=");
    if (k) parsed[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return parsed;
};

/** v0.6 sent HTML with `type("text/html")`, which Fastify completed to this value. */
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

export default function claimRoutes(opts: ClaimRouteOptions) {
  const { getClaimToken, consumeClaimToken, dashboardUrl } = opts;
  const app = createRouter();

  /**
   * GET /claim?token=<token>
   * Renders a minimal HTML form for entering the owner email.
   * If users already exist, redirects to /login.
   */
  app.get("/", async (c) => {
    const db: Db = c.var.db;

    // If any user exists, claim is over.
    const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length > 0) {
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    const token = c.req.query("token");
    const validToken = getClaimToken();
    if (!token || !validToken || token !== validToken) {
      return c.html(`
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
      `, 403, HTML_HEADERS);
    }

    return c.html(`
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
    `, 200, HTML_HEADERS);
  });

  /**
   * POST /claim
   * Consumes the claim token, creates the owner user, starts a session.
   */
  app.post("/", parseBody({ parsers: { "application/x-www-form-urlencoded": parseClaimForm } }), async (c) => {
    const db: Db = c.var.db;

    // If any user exists, claim is over.
    const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length > 0) {
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    // Parse form body (application/x-www-form-urlencoded)
    const body = c.var.body as Record<string, string> | undefined;
    const token = body?.token;
    const email = body?.email?.toLowerCase().trim();

    const validToken = getClaimToken();
    if (!token || !validToken || token !== validToken) {
      return c.html(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid or expired token</h1>
          <p>This claim link is no longer valid. Check the latest container logs for the current URL.</p>
        </body></html>
      `, 403, HTML_HEADERS);
    }

    if (!email || !email.includes("@") || email.length < 3) {
      return c.html(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid email</h1>
          <p>Please provide a valid email address.</p>
          <a href="javascript:history.back()">Go back</a>
        </body></html>
      `, 400, HTML_HEADERS);
    }

    // Find the default tenant (created by bootstrapSeed).
    const tenantRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "default"))
      .limit(1);

    if (tenantRows.length === 0) {
      return c.html(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Setup error</h1>
          <p>No tenant found. The server may not have completed bootstrap.</p>
        </body></html>
      `, 500, HTML_HEADERS);
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
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    // Consume the claim token (single-use).
    consumeClaimToken();

    // Create a session and sign the user in.
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [session] = await db
      .insert(sessions)
      .values({ tenantId, userId: newUser.id, expiresAt })
      .returning({ id: sessions.id });

    setCookie(c, SESSION_COOKIE_NAME, session!.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    // Redirect to the dashboard.
    return c.redirect(`${dashboardUrl}/`, 302);
  });

  return app;
}
