/**
 * Compliance: footer injection and header generation for outgoing email.
 *
 * CAN-SPAM / RFC 8058 requirements enforced by the drain immediately before
 * the adapter send. These are not persisted to the message row - the stored
 * body is the approved draft; the delivered body additionally carries the
 * compliance footer.
 *
 * Footer content (CAN-SPAM Section 5(a)(5)-(6) / best-practice basis):
 *   - Unsubscribe link (one-click URL for the specific message)
 *   - Tenant's physical postal address (required by CAN-SPAM for commercial email)
 *
 * The footer text is deterministic from:
 *   1. The tenant's configured postal address (tenants.settings.postal_address)
 *   2. The unsubscribe token for this message
 *   3. The base URL for the unsubscribe endpoint (BASE_URL env var)
 *
 * Enforcement:
 *   - A tenant with no postal address configured cannot send. The message
 *     reverts to 'approved' (not a transport failure, not a retry burn) and the
 *     operator gets a clear log error.
 *   - A missing UNSUBSCRIBE_SIGNING_KEY is treated identically: configuration
 *     fault, not transport fault. The message reverts to 'approved', no retry
 *     is consumed, and a clear operator-facing log error is emitted. Nothing
 *     sends without a valid key; fail-closed is preserved.
 *   - An unusable BASE_URL in production (localhost/loopback, non-https, or
 *     unparseable) is treated identically: configuration fault, not transport
 *     fault. The message reverts to 'approved', no retry is consumed, and a
 *     clear operator-facing log error is emitted. This is more dangerous than
 *     either of the above because the wrong value is permanently baked into the
 *     unsubscribe link of every delivered email and cannot be corrected
 *     retroactively. Outside production the check is suppressed so the
 *     self-host quickstart (http://localhost:3000) continues to work.
 *   Not sending is the safe failure; sending without the required footer or
 *   without a verifiable unsubscribe token is a legal violation.
 *
 * List-Unsubscribe header (RFC 8058):
 *   List-Unsubscribe: <https://.../unsubscribe/one-click?token=...>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * [impl] The mailto: form (RFC 2369 conventional fallback) is intentionally
 * omitted. Nothing in this system processes inbound mail, so advertising a
 * mailto: address would silently discard unsubscribe requests sent by mail
 * clients that support only that form. RFC 2369 permits omitting mailto: when
 * no inbound processing exists. The bulk-sender rules (Gmail, Yahoo 2024)
 * require the one-click HTTPS form, which is fully implemented. If a monitored
 * inbound address is added in the future, the mailto: form can be restored; see
 * BACKLOG.md "Restore List-Unsubscribe mailto form".
 */
import { generateUnsubscribeToken } from "@claros/adapters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for building compliance metadata for a single outgoing message. */
export interface ComplianceInput {
  /** Tenant UUID. */
  tenantId: string;
  /** Message UUID (lifecycle_messages.id). */
  messageId: string;
  /** Tenant's physical postal address (from tenants.settings.postal_address). */
  postalAddress: string;
  /** Base URL for the hosted unsubscribe page (no trailing slash). */
  baseUrl: string;
  /**
   * HMAC signing key for unsubscribe token generation.
   *
   * The drain resolves this via resolveSigningKey() before calling
   * buildComplianceOutput, ensuring a missing key reverts the message to
   * 'approved' without throwing (same treatment as a missing postal address).
   * Passing the resolved key here keeps buildComplianceOutput free of
   * environment reads.
   */
  signingKey: string;
  /**
   * Topic of the message when its kind is not 'transactional': the token then
   * carries it and one-click unsubscribes that topic only. Omit for messages
   * without a topic (the whole product, as before topics).
   */
  topicId?: string | null;
}

/** Compliance output: ready-to-inject headers and footer strings. */
export interface ComplianceOutput {
  /** List-Unsubscribe header value (RFC 2369 + RFC 8058). */
  listUnsubscribeHeader: string;
  /** List-Unsubscribe-Post header value (RFC 8058 one-click). */
  listUnsubscribePostHeader: string;
  /** Full unsubscribe URL (used in the footer link). */
  unsubscribeUrl: string;
  /** Plain text footer to append to text/plain body. */
  textFooter: string;
  /** HTML footer to append to text/html body. */
  htmlFooter: string;
}

// ---------------------------------------------------------------------------
// Base URL resolution and validation
// ---------------------------------------------------------------------------

/**
 * Resolve the base URL for the unsubscribe endpoint.
 *
 * For self-hosted installs the operator sets BASE_URL to their domain,
 * e.g. https://mail.example.com.
 * The default of http://localhost:3000 is only valid in local development
 * and will produce non-functional unsubscribe links in production - but the
 * production error is visible (links don't work) rather than silent (wrong
 * address suppressed).
 *
 * BASE_URL has no trailing slash by convention (enforced here).
 */
export function resolveBaseUrl(override?: string): string {
  const raw = override ?? process.env.BASE_URL ?? "http://localhost:3000";
  // Strip trailing slash for consistent URL construction.
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * The base URL for links in a product's mail: https://<public_host> when
 * the product has a public host, else the instance base URL.
 */
export function productLinkBaseUrl(baseUrl: string, publicHost: string | null | undefined): string {
  return publicHost ? `https://${publicHost}` : baseUrl;
}

/**
 * The set of loopback hostnames and address prefixes that are never valid
 * in production. IPv4 loopback covers the full 127.0.0.0/8 range.
 * IPv6 loopback appears both as "::1" (URL.hostname without brackets) and
 * "[::1]" (URL.hostname with brackets, as returned by some runtimes).
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // IPv4 loopback range: 127.x.x.x
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

/**
 * Check whether a resolved base URL is safe to use for production sends.
 *
 * A URL is "unusable" in production when:
 *   - It cannot be parsed as a URL (malformed)
 *   - Its hostname is a loopback / localhost address
 *   - Its scheme is not https
 *
 * The check is gated on NODE_ENV === 'production' so local development and the
 * self-host quickstart (which rely on http://localhost:3000) are never blocked.
 * Outside production every URL is considered valid; the check returns null.
 *
 * Returns null when the URL is acceptable, or a non-empty reason string when it
 * is not. Callers use this as a configuration fault gate identical to the missing
 * postal address and missing signing key checks: revert the message to 'approved',
 * no retry consumed, operator-visible log error.
 *
 * @param baseUrl - Already-resolved URL (no trailing slash). From resolveBaseUrl().
 * @param isProduction - Override for testing. Defaults to NODE_ENV === 'production'.
 */
export function checkBaseUrl(baseUrl: string, isProduction?: boolean): string | null {
  const prod = isProduction !== undefined ? isProduction : process.env.NODE_ENV === "production";

  // Outside production: all values are permitted. The quickstart depends on
  // http://localhost:3000 and must not be blocked.
  if (!prod) return null;

  // Check 1: parse.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `BASE_URL "${baseUrl}" is not a valid URL. Set BASE_URL to the HTTPS domain where Claros is hosted.`;
  }

  // Check 2: loopback / localhost.
  if (isLoopback(parsed.hostname)) {
    return (
      `BASE_URL resolves to a loopback address ("${parsed.hostname}") in production. ` +
      `Unsubscribe links baked into delivered emails would point at localhost and cannot be corrected. ` +
      `Set BASE_URL to the HTTPS domain where Claros is hosted.`
    );
  }

  // Check 3: HTTPS required.
  if (parsed.protocol !== "https:") {
    return (
      `BASE_URL uses scheme "${parsed.protocol.replace(":", "")}" instead of https in production. ` +
      `Unsubscribe links baked into delivered emails would use an insecure scheme. ` +
      `Set BASE_URL to an https:// URL.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signing key availability check
// ---------------------------------------------------------------------------

/**
 * Check whether UNSUBSCRIBE_SIGNING_KEY is present and non-empty.
 *
 * Returns the raw key string if available, or null if absent. Callers use
 * this to gate sending: a missing key is a configuration fault, not a
 * transport fault. The message reverts to 'approved' (same treatment as a
 * missing postal address), no retry is consumed, and the operator gets a
 * clear log error. Nothing sends without a valid key; fail-closed is
 * preserved.
 *
 * @param keyOverride - Optional explicit key (for testing).
 */
export function resolveSigningKey(keyOverride?: string): string | null {
  const raw = keyOverride ?? process.env.UNSUBSCRIBE_SIGNING_KEY;
  if (!raw || raw.length === 0) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Compliance output builder
// ---------------------------------------------------------------------------

/**
 * Build compliance headers and footer text for a single outgoing message.
 *
 * The token is generated fresh here (deterministic HMAC - same inputs produce
 * the same token). No state is stored.
 *
 * Footer text follows these requirements:
 *   - CAN-SPAM: physical postal address of the sender
 *   - CAN-SPAM / GDPR best practice: clear unsubscribe instruction + link
 *   - Kept minimal and plain - no brand, no tracking, renders in all clients
 */
export function buildComplianceOutput(input: ComplianceInput): ComplianceOutput {
  const token = generateUnsubscribeToken(input.tenantId, input.messageId, input.signingKey, {
    topicId: input.topicId ?? null,
  });

  const oneClickUrl = `${input.baseUrl}/unsubscribe/one-click?token=${token}`;
  const browserUrl = `${input.baseUrl}/unsubscribe?token=${token}`;

  // RFC 8058 List-Unsubscribe: HTTPS one-click form only.
  // The mailto: form is intentionally omitted - see module-level [impl] note.
  const listUnsubscribeHeader = `<${oneClickUrl}>`;
  const listUnsubscribePostHeader = "List-Unsubscribe=One-Click";

  // Plain text footer (appended after a blank line separator).
  const textFooter = [
    "",
    "---",
    `To unsubscribe: ${browserUrl}`,
    `${input.postalAddress}`,
  ].join("\n");

  // HTML footer (appended before closing </body> tag, or at end of HTML).
  // Uses inline styles only - no external CSS, must render in all email clients.
  const htmlFooter = [
    `<div style="margin-top:40px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:12px;color:#888;font-family:sans-serif;line-height:1.5;">`,
    `  <p style="margin:0 0 4px 0;">You are receiving this email because you signed up for our service.</p>`,
    `  <p style="margin:0 0 4px 0;"><a href="${browserUrl}" style="color:#888;">Unsubscribe</a> from these emails.</p>`,
    `  <p style="margin:0;">${escapeHtml(input.postalAddress)}</p>`,
    `</div>`,
  ].join("\n");

  return {
    listUnsubscribeHeader,
    listUnsubscribePostHeader,
    unsubscribeUrl: browserUrl,
    textFooter,
    htmlFooter,
  };
}

// ---------------------------------------------------------------------------
// Body injection
// ---------------------------------------------------------------------------

/**
 * Append the compliance footer to an HTML body.
 *
 * If the body contains a closing </body> tag, inserts the footer before it.
 * Otherwise appends to the end. The injection is purely additive - never
 * modifies existing content.
 */
export function injectHtmlFooter(html: string, footer: string): string {
  const closingBodyIdx = html.toLowerCase().lastIndexOf("</body>");
  if (closingBodyIdx !== -1) {
    return html.slice(0, closingBodyIdx) + "\n" + footer + "\n" + html.slice(closingBodyIdx);
  }
  return html + "\n" + footer;
}

/**
 * Append the compliance footer to a plain text body.
 *
 * The footer already contains a leading blank line + separator.
 */
export function injectTextFooter(text: string, footer: string): string {
  return text + footer;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
