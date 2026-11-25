/**
 * Claim route - first-account creation for fresh installs.
 *
 * When no users exist, a one-time claim URL is minted: the Node server mints
 * it at startup and logs it; on Cloudflare Workers the deploy CLI
 * (`claros deploy`, `claros claim-url`) mints it. GET /claim?token=<token>
 * renders a form where the installer enters their email. POST /claim
 * consumes the token, creates the owner, and signs them in.
 *
 * Design decisions:
 * - Tokens live in the claim_tokens table, hashed (SHA-256 hex); the raw
 *   token is only in the URL. Works the same on every instance behind a
 *   load balancer and on Workers, which have no startup step.
 * - 24 hour expiry. Node mints a new token on every restart while unclaimed
 *   and deletes older unconsumed ones (latest logs win).
 * - Single-use: POST consumes the token with an atomic CAS before creating
 *   the owner, so exactly one of N concurrent claims proceeds.
 * - After an owner exists: GET /claim returns a redirect to /login regardless
 *   of token validity. With the per-request gate (Workers) the routes answer
 *   404 instead, as if they were not mounted.
 */
import { createHash } from "node:crypto";
import { setCookie } from "hono/cookie";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { SESSION_COOKIE_NAME } from "./auth.js";
import { createRouter, parseBody } from "../http/router.js";
import type { BodyParser } from "../http/body.js";

const SESSION_TTL_DAYS = 30;

/** Lifetime of a claim token. */
export const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** The stored form of a claim token: SHA-256, hex. The deploy CLI computes the same. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface ClaimRouteOptions {
  /** Dashboard URL for post-claim redirect. */
  dashboardUrl: string;
  /**
   * A raw token handed to the app (buildApp's `claimToken` option). It is
   * written to claim_tokens (hashed, 24 hour expiry) on the first claim
   * request unless it is already there; the Node server also writes it at boot.
   */
  seedToken?: string | null;
  /**
   * Per-request gate: when it resolves false the routes answer 404 as if
   * they were not mounted. Used on Workers, where the routes are mounted
   * only while no user exists.
   */
  isOpen?: (db: Db) => Promise<boolean>;
  /** Create the default tenant when it is missing (Workers have no boot seed). */
  seedDefaultTenant?: boolean;
  /** Called after a successful claim (lets the gate close at once). */
  onClaimed?: () => void;
  /** How to get a new link, shown on the invalid-link page. */
  newLinkHint?: "logs" | "cli";
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

/** Escape a value for an HTML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** v0.6 sent HTML with `type("text/html")`, which Fastify completed to this value. */
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

const INVALID_HINT_LOGS = `<p>This link is invalid or has expired. Each server start mints a new
          claim URL (valid for 24 hours) and the previous one stops working.</p>
          <p>Fix: open the URL from the latest server logs.</p>
          <pre>docker compose logs app | grep "claim"</pre>`;

const INVALID_HINT_CLI = `<p>This link is invalid or has expired. Claim links are valid for 24 hours
          and work once.</p>
          <p>Fix: mint a new one with</p>
          <pre>npx claros claim-url</pre>`;

export default function claimRoutes(opts: ClaimRouteOptions) {
  const { dashboardUrl } = opts;
  const app = createRouter();
  const invalidHint = opts.newLinkHint === "cli" ? INVALID_HINT_CLI : INVALID_HINT_LOGS;

  // The seed token is written once per app (lazily, so building the app
  // never touches the database).
  let seeded: Promise<void> | null = null;
  const ensureSeed = (db: Db): Promise<void> => {
    if (!opts.seedToken) return Promise.resolve();
    if (!seeded) {
      seeded = storeFor(db)
        .apiClaim.ensureClaimToken({
          tokenHash: hashClaimToken(opts.seedToken),
          expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
        })
        .catch((err) => {
          seeded = null;
          throw err;
        });
    }
    return seeded;
  };

  /** True when the token is a live claim token. */
  const tokenIsValid = async (db: Db, token: string | undefined): Promise<boolean> => {
    if (!token) return false;
    await ensureSeed(db);
    return storeFor(db).apiClaim.isClaimTokenValid({ tokenHash: hashClaimToken(token), now: new Date() });
  };

  /**
   * GET /claim?token=<token>
   * Renders a minimal HTML form for entering the owner email.
   * If users already exist, redirects to /login.
   */
  app.get("/", async (c) => {
    const db: Db = c.var.db;
    if (opts.isOpen && !(await opts.isOpen(db))) return c.notFound();

    // If any user exists, claim is over.
    if (await storeFor(db).apiClaim.anyUserExists()) {
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    const token = c.req.query("token");
    if (!(await tokenIsValid(db, token))) {
      return c.html(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Invalid claim link</h1>
          ${invalidHint}
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
          <input type="hidden" name="token" value="${escapeAttr(token!)}" />
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
    if (opts.isOpen && !(await opts.isOpen(db))) return c.notFound();

    // If any user exists, claim is over.
    if (await storeFor(db).apiClaim.anyUserExists()) {
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    // Parse form body (application/x-www-form-urlencoded)
    const body = c.var.body as Record<string, string> | undefined;
    const token = body?.token;
    const email = body?.email?.toLowerCase().trim();

    if (!(await tokenIsValid(db, token))) {
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

    // Find the default tenant (created by bootstrapSeed; on Workers, here).
    let tenantId = await storeFor(db).apiClaim.findDefaultTenantId();
    if (tenantId === null && opts.seedDefaultTenant) {
      await storeFor(db).serverMain.bootstrapSeed(null);
      tenantId = await storeFor(db).apiClaim.findDefaultTenantId();
    }

    if (tenantId === null) {
      return c.html(`
        <!doctype html>
        <html><head><title>Claros</title></head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;">
          <h1>Setup error</h1>
          <p>No tenant found. The server may not have completed bootstrap.</p>
        </body></html>
      `, 500, HTML_HEADERS);
    }

    // Consume the claim token (single-use, CAS): exactly one request goes on.
    const consumed = await storeFor(db).apiClaim.consumeClaimToken({ tokenHash: hashClaimToken(token!), now: new Date() });
    if (!consumed) {
      // A concurrent claim consumed it first.
      return c.redirect(`${dashboardUrl}/login`, 302);
    }

    // Create the owner user.
    const newUserId = await storeFor(db).apiClaim.createOwnerUser({ tenantId, email });

    if (!newUserId) {
      // Race condition: another request created a user. Redirect to login.
      return c.redirect(`${dashboardUrl}/login`, 302);
    }
    opts.onClaimed?.();

    // Create a session and sign the user in.
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const sessionId = await storeFor(db).apiClaim.createSession({ tenantId, userId: newUserId, expiresAt });

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
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
