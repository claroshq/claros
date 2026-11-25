/**
 * Unsubscribe routes - public, unauthenticated.
 *
 * Three endpoints, all stateless-token-verified, all write a suppression row
 * on success, all idempotent (second call for an already-suppressed address
 * is a success, not an error).
 *
 * RFC 8058 one-click (mailbox provider automation):
 *   POST /unsubscribe/one-click
 *     Body: application/x-www-form-urlencoded  { List-Unsubscribe=One-Click }
 *     Query: ?token=<token>
 *     Caller: mailbox provider (Gmail, Yahoo, etc.)
 *     Returns: 200 JSON { unsubscribed: true }
 *     Contract: must be a plain POST with no redirect; the provider does not
 *     follow redirects and does not render responses.
 *
 * Browser-facing GET (human confirmation page):
 *   GET /unsubscribe
 *     Query: ?token=<token>
 *     Caller: human clicking the link in an email
 *     Returns: 200 HTML page confirming the action and showing a submit button.
 *     Contract: GET must NEVER suppress. A link preview, scanner, or crawler
 *     fetching the URL must not unsubscribe the contact. The human must click.
 *
 * Browser-facing POST (human submits the confirmation form):
 *   POST /unsubscribe
 *     Body: application/x-www-form-urlencoded  { token=<token> }
 *       OR  application/json  { token: "<token>" }
 *     Caller: browser submitting the form from the GET page
 *     Returns: 200 HTML confirmation page (or JSON { unsubscribed: true } for
 *     programmatic callers that send application/json).
 *
 * Distinguishing one-click POST from browser POST:
 *   - One-click: token is in the query string; body is the RFC 8058 sentinel
 *     { List-Unsubscribe: "One-Click" }. Route is /unsubscribe/one-click.
 *   - Browser POST: token is in the body (form field or JSON field). Route is
 *     /unsubscribe. Different paths, different callers, different bodies.
 *   - The two routes can share the internal "resolve and suppress" logic but
 *     must remain separate endpoints because their URL shapes are embedded in
 *     email headers and must never collide.
 *
 * Address resolution:
 *   The token encodes the message ID (not the contact ID). The address is
 *   resolved from lifecycle_messages.recipient_address - the address the drain
 *   prepared the message for, written before the send attempt. The endpoint
 *   additionally requires status = 'sent' to confirm delivery actually occurred.
 *   Writing recipient_address before the send covers the crash window where the
 *   provider accepted the message but the post-send DB write never completed;
 *   in that case reap will eventually recover the row to 'sent'. A token for a
 *   message at any other status (sending, failed, approved, etc.) is treated as
 *   invalid and nothing is suppressed. If the message row no longer exists
 *   (deleted or purged), the token is also treated as invalid - same opaque 400.
 *
 * Failure behavior:
 *   An invalid or unverifiable token returns 400 with { error: "Invalid unsubscribe link." }.
 *   The same response is returned for all failure reasons (malformed, bad_signature,
 *   invalid_payload, message not found, not status='sent', recipient_address absent)
 *   so callers cannot distinguish which part failed. No information about whether
 *   the underlying message or contact exists is revealed.
 *
 * Product public hosts:
 *   Mail of a product with a public_host links to https://<public_host>. A
 *   request that arrives on a product's public host is answered only for
 *   tokens of that product; any other token gets 404 there (before any
 *   suppression is written). Requests on the instance host (BASE_URL) serve
 *   every product, so links in mail sent before a host was set keep working.
 *
 * Migration check:
 *   This implementation requires migration 0015 (recipient_address column on
 *   lifecycle_messages). That migration must be applied before this code runs.
 */
import { storeFor } from "@claros/store";
import { verifyUnsubscribeToken } from "@claros/adapters";
import type { Db } from "../plugins/db.js";
import { createRouter, parseBody } from "../http/router.js";
import { parseForm } from "../http/body.js";
import { notFound } from "../http/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suppression reason written by all unsubscribe endpoints. */
const UNSUBSCRIBE_REASON = "unsubscribe" as const;

/** Source for one-click RFC 8058 endpoint. */
const SOURCE_ONE_CLICK = "one_click" as const;

/** Source for browser-facing POST endpoint. */
const SOURCE_PAGE = "page" as const;

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

/**
 * Resolve a token, look up the recipient_address from the message row,
 * confirm status = 'sent', write a suppression, return the email.
 *
 * Returns { ok: true, email } on success, or { ok: false } on any failure.
 * All failure modes return the same shape to avoid leaking which step failed.
 *
 * Status check: recipient_address is written before the send attempt, so it
 * may be set on messages that never completed delivery (status = 'sending',
 * 'failed', etc.). Requiring status = 'sent' ensures the token only resolves
 * for messages that actually went out.
 *
 * Normalization: the email is lowercased before insertion (same as the import
 * path). The functional unique index on (tenant_id, lower(email)) ensures
 * idempotency.
 */
async function resolveAndSuppress(
  db: Db,
  token: string,
  source: typeof SOURCE_ONE_CLICK | typeof SOURCE_PAGE,
): Promise<{ ok: true; email: string } | { ok: false; missingKey?: true }> {
  // Step 1: verify the token.
  // verifyUnsubscribeToken throws when UNSUBSCRIBE_SIGNING_KEY is absent - that
  // is a server misconfiguration, not a bad token. Catch and surface as a
  // distinct missingKey flag so routes can return 503 rather than 500.
  let result: ReturnType<typeof verifyUnsubscribeToken>;
  try {
    result = verifyUnsubscribeToken(token);
  } catch {
    return { ok: false, missingKey: true };
  }
  if (!result.ok) {
    return { ok: false };
  }

  const { tenantId, messageId } = result.payload;

  // Step 2: resolve the message row - must exist, have status = 'sent', and
  // have a recipient_address set. recipient_address is written before the send
  // attempt, so it may be present on messages that failed or are still in
  // transit. The status = 'sent' check is the authoritative proof of delivery.
  const messageRow = await storeFor(db).apiUnsubscribe.getMessageRecipient({ tenantId, messageId });

  if (messageRow === null) {
    // Message row does not exist (purged, or token forged with a non-existent ID).
    // Return the same opaque failure - no enumeration.
    return { ok: false };
  }

  const { recipientAddress, status } = messageRow;

  if (status !== "sent") {
    // Message exists but was not successfully delivered. This covers:
    //   - status = 'approved' or 'sending': not yet sent (recipient_address may
    //     be null or set; either way delivery has not occurred)
    //   - status = 'failed': permanent transport failure; message never delivered
    //   - any other non-terminal status: also not delivered
    // Token is structurally valid but the message was not sent - reject.
    return { ok: false };
  }

  if (!recipientAddress || recipientAddress.trim().length === 0) {
    // Sent message with no recipient_address recorded - should not happen in
    // normal operation (drain always writes it before the send attempt), but
    // treat it as invalid for safety.
    return { ok: false };
  }

  // Normalize: lowercase the email before storage.
  const normalizedEmail = recipientAddress.toLowerCase();

  // Step 3: write the suppression - idempotent via ON CONFLICT DO NOTHING
  await storeFor(db).apiUnsubscribe.suppressAddress({
    tenantId,
    email: normalizedEmail,
    reason: UNSUBSCRIBE_REASON,
    source,
  });

  return { ok: true, email: normalizedEmail };
}

/** Lowercase host name of the request (no port). */
function requestHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * False when the request arrived on a product's public host and the token
 * belongs to another product (the caller answers 404).
 */
async function hostAllowsTenant(db: Db, url: string, tenantId: string): Promise<boolean> {
  const host = requestHost(url);
  if (!host) return true;
  const hostTenant = await storeFor(db).apiUnsubscribe.findTenantIdByPublicHost(host);
  return hostTenant === null || hostTenant === tenantId;
}

/** Tenant id of a token whose signature verifies, or null (no throw). */
function tokenTenant(token: string): string | null {
  try {
    const r = verifyUnsubscribeToken(token);
    return r.ok ? r.payload.tenantId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Minimal HTML for the unsubscribe confirmation page (GET).
 * Shows a button the human must click; does not auto-submit.
 * Deliberately plain - no brand assets needed, must render in any email client's
 * browser view.
 */
function unsubscribePageHtml(token: string): string {
  // Escape token for HTML attribute (base64url chars are safe, but be explicit)
  const safeToken = token.replace(/[^A-Za-z0-9._~-]/g, "");
  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"UTF-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Unsubscribe</title>",
    "  <style>",
    "    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #111; }",
    "    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }",
    "    p { color: #555; margin-bottom: 1.5rem; }",
    "    button { background: #d00; color: #fff; border: none; padding: 12px 24px; font-size: 1rem; cursor: pointer; border-radius: 4px; }",
    "    button:hover { background: #b00; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>Unsubscribe</h1>",
    "  <p>Click the button below to unsubscribe and stop receiving emails from this sender.</p>",
    "  <form method=\"POST\" action=\"/unsubscribe\">",
    `    <input type=\"hidden\" name=\"token\" value=\"${safeToken}\">`,
    "    <button type=\"submit\">Unsubscribe me</button>",
    "  </form>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** HTML shown after a successful unsubscribe. */
function unsubscribeSuccessHtml(): string {
  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"UTF-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Unsubscribed</title>",
    "  <style>",
    "    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #111; }",
    "    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }",
    "    p { color: #555; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>Unsubscribed</h1>",
    "  <p>You have been unsubscribed. You will no longer receive emails from this sender.</p>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** HTML shown when the token is invalid or resolution fails. */
function unsubscribeErrorHtml(): string {
  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"UTF-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Invalid link</title>",
    "  <style>",
    "    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #111; }",
    "    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }",
    "    p { color: #555; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>Invalid link</h1>",
    "  <p>This unsubscribe link is invalid. It may have been corrupted or is no longer valid.</p>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** Content-Type v0.6 set explicitly on every HTML response. */
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

/**
 * Public unsubscribe routes.
 *
 * Registered outside the /v1 authenticated scope in app.ts.
 * No session cookie required. No tenant resolved from session.
 * Tenant is resolved entirely from the token payload.
 */
export default function unsubscribeRoutes() {
  const app = createRouter();

  // Form body parser for this scope (needed for browser POST and one-click).
  // application/x-www-form-urlencoded for browser form submissions and RFC 8058.
  // Key=value pairs parsed manually by parseForm (same semantics as the v0.6
  // parser, no new dependency). JSON uses the default parser.
  const body = parseBody({ parsers: { "application/x-www-form-urlencoded": parseForm } });

  // ---------------------------------------------------------------------------
  // POST /unsubscribe/one-click  (RFC 8058 - mailbox provider automation)
  // ---------------------------------------------------------------------------

  app.post("/one-click", body, async (c) => {
    if (!c.var.db) {
      return c.json({ error: "Service unavailable." }, 503);
    }

    const db: Db = c.var.db;
    const token = c.req.query("token");

    if (!token || token.length === 0) {
      return c.json({ error: "Invalid unsubscribe link." }, 400);
    }

    const tenantOfToken = tokenTenant(token);
    if (tenantOfToken && !(await hostAllowsTenant(db, c.req.url, tenantOfToken))) return notFound(c);

    const outcome = await resolveAndSuppress(db, token, SOURCE_ONE_CLICK);

    if (!outcome.ok) {
      if (outcome.missingKey) {
        // UNSUBSCRIBE_SIGNING_KEY not configured - server misconfiguration.
        // Return 503 so the provider knows to retry rather than treating this
        // as a permanent invalid-token response.
        return c.json({ error: "Service unavailable." }, 503);
      }
      // Do not reveal which part failed or whether the message exists.
      return c.json({ error: "Invalid unsubscribe link." }, 400);
    }

    return c.json({ unsubscribed: true }, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /unsubscribe  (browser confirmation page)
  // ---------------------------------------------------------------------------
  // MUST NOT suppress. A link preview, bot, or scanner fetching this URL
  // must not unsubscribe the human. Only the POST performs the action.

  app.get("/", async (c) => {
    const token = c.req.query("token") ?? "";

    // Validate the token structurally (so we show the error page immediately
    // for obviously invalid links) but do NOT perform any DB write.
    // We also do not reveal whether the token is valid or the message exists -
    // both a valid token and an invalid one render the form (valid) or the
    // error page (invalid).
    if (!token || token.length === 0) {
      return c.html(unsubscribeErrorHtml(), 400, HTML_HEADERS);
    }

    // Verify the token structure/signature only - no DB lookup here.
    // verifyUnsubscribeToken throws if UNSUBSCRIBE_SIGNING_KEY is absent.
    // In that case render the error page (503 would confuse a human; 400 is
    // accurate from the user's view since no valid page can be shown).
    let verifyResult: ReturnType<typeof verifyUnsubscribeToken>;
    try {
      verifyResult = verifyUnsubscribeToken(token);
    } catch {
      return c.html(unsubscribeErrorHtml(), 503, HTML_HEADERS);
    }
    if (!verifyResult.ok) {
      return c.html(unsubscribeErrorHtml(), 400, HTML_HEADERS);
    }

    if (c.var.db && !(await hostAllowsTenant(c.var.db, c.req.url, verifyResult.payload.tenantId))) {
      return notFound(c);
    }

    return c.html(unsubscribePageHtml(token), 200, HTML_HEADERS);
  });

  // ---------------------------------------------------------------------------
  // POST /unsubscribe  (browser form submission)
  // ---------------------------------------------------------------------------

  app.post("/", body, async (c) => {
    if (!c.var.db) {
      return c.json({ error: "Service unavailable." }, 503);
    }

    const db: Db = c.var.db;

    // Extract token from body (form field or JSON field)
    const reqBody = c.var.body as Record<string, unknown>;
    const token = typeof reqBody?.token === "string" ? reqBody.token : "";

    if (!token || token.length === 0) {
      const contentType = (c.req.header("content-type") ?? "").toLowerCase();
      if (contentType.includes("application/json")) {
        return c.json({ error: "Invalid unsubscribe link." }, 400);
      }
      return c.html(unsubscribeErrorHtml(), 400, HTML_HEADERS);
    }

    const tenantOfToken = tokenTenant(token);
    if (tenantOfToken && !(await hostAllowsTenant(db, c.req.url, tenantOfToken))) return notFound(c);

    const outcome = await resolveAndSuppress(db, token, SOURCE_PAGE);

    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const wantsJson = contentType.includes("application/json");

    if (!outcome.ok) {
      if (outcome.missingKey) {
        // UNSUBSCRIBE_SIGNING_KEY not configured - server misconfiguration.
        if (wantsJson) {
          return c.json({ error: "Service unavailable." }, 503);
        }
        return c.html(unsubscribeErrorHtml(), 503, HTML_HEADERS);
      }
      if (wantsJson) {
        return c.json({ error: "Invalid unsubscribe link." }, 400);
      }
      return c.html(unsubscribeErrorHtml(), 400, HTML_HEADERS);
    }

    if (wantsJson) {
      return c.json({ unsubscribed: true }, 200);
    }

    return c.html(unsubscribeSuccessHtml(), 200, HTML_HEADERS);
  });

  return app;
}
