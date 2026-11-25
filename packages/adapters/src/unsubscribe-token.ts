/**
 * Unsubscribe token: stateless HMAC-signed tokens for one-click unsubscribe.
 *
 * Design constraints (from task 32b [impl] decisions):
 *
 *   1. Stateless and HMAC-signed: no database row, no expiry.
 *   2. Encodes tenant and message by identifier only, NEVER the email address.
 *      Personal data must not appear in URLs (provider logs, referrer headers,
 *      proxy logs). The endpoint resolves the email from the message row.
 *   3. Encoding the message identifier (not the contact identifier) solves two
 *      problems:
 *        a. Address stability: the unsubscribe always suppresses the address
 *           that the message was prepared for (written to recipient_address on the
 *           message row before the send attempt), not whatever the contact holds today.
 *           If the address changed after delivery, the old address is suppressed
 *           and the new address is not touched - correct in both directions.
 *        b. Attribution: an unsubscribe is attributed to the specific message
 *           and therefore to the flow that caused it. This enables per-flow
 *           unsubscribe analytics.
 *   4. Signing key is its own environment variable (UNSUBSCRIBE_SIGNING_KEY),
 *      not derived from ENCRYPTION_KEY. This key can never be rotated without
 *      breaking every unsubscribe link in already-delivered email, which is a
 *      compliance failure. Treat as permanent and back up accordingly.
 *   5. In production a missing signing key fails closed (throws at generation
 *      and verification time). In development, a missing key also throws -
 *      callers that need to test the "no key" path must set
 *      UNSUBSCRIBE_SIGNING_KEY to an empty string.
 *   6. Constant-time comparison for the signature (timingSafeEqual).
 *
 * Token format (URL-safe base64, no padding):
 *
 *   BASE64URL( JSON({ tenantId, messageId, v }) ) + "." + BASE64URL( HMAC-SHA256 )
 *
 *   The payload is a JSON object so future fields can be added without
 *   changing the separator format. The version field "v" lets us introduce
 *   a new signing algorithm without a flag day.
 *
 * Verification error types are distinct so callers can decide the response
 * without leaking which part failed to the outside world. The endpoint must
 * return the same opaque HTTP status regardless of the internal error reason.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The decoded, verified payload carried inside an unsubscribe token. */
export interface UnsubscribeTokenPayload {
  /** Tenant UUID. */
  tenantId: string;
  /** Message UUID (lifecycle_messages.id). */
  messageId: string;
  /** Schema version. Currently always 1. */
  v: 1;
  /**
   * Topic UUID (topics.id), present on tokens of messages with a
   * non-transactional topic: one-click then unsubscribes that topic only.
   * Absent on older tokens and on messages without a topic: the whole
   * product is unsubscribed, as before topics.
   */
  topicId?: string;
}

/** Discriminated error union returned by verifyUnsubscribeToken. */
export type UnsubscribeTokenError =
  | { kind: "malformed" }      // not parseable as base64url.base64url, or JSON fails
  | { kind: "bad_signature" }  // signature does not match (tamper or wrong key)
  | { kind: "invalid_payload" }; // JSON parsed but required fields missing or wrong type

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current token payload schema version. */
const PAYLOAD_VERSION = 1 as const;

/** The algorithm used for HMAC signing. */
const HMAC_ALGORITHM = "sha256";

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

/**
 * Resolve the HMAC signing key from an explicit value or the environment.
 *
 * Called at token generation and verification time. In production (NODE_ENV
 * is "production" or absent/undefined), a missing key throws so the caller
 * fails closed rather than silently proceeding with no signing. In development
 * and test, a missing key also throws - callers that need to test the
 * "no key" path must set UNSUBSCRIBE_SIGNING_KEY to an empty string.
 *
 * @param keyOverride - Optional explicit key (for testing).
 * @returns The key as a Buffer.
 */
function resolveKey(keyOverride?: string): Buffer {
  const raw = keyOverride ?? process.env.UNSUBSCRIBE_SIGNING_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      "UNSUBSCRIBE_SIGNING_KEY is not set. " +
        "This key is required for unsubscribe link generation and verification. " +
        "It must be treated as permanent - rotating it breaks all outstanding links.",
    );
  }
  return Buffer.from(raw, "utf8");
}

// ---------------------------------------------------------------------------
// Signing / generation
// ---------------------------------------------------------------------------

/**
 * Sign a payload object and return the HMAC-SHA256 digest as a Buffer.
 */
function sign(payloadBase64: string, key: Buffer): Buffer {
  return createHmac(HMAC_ALGORITHM, key)
    .update(payloadBase64)
    .digest();
}

/**
 * Generate a stateless HMAC-signed unsubscribe token.
 *
 * The token encodes tenantId and messageId by UUID only. The email address
 * is never included. The endpoint resolves the address from the message row's
 * recipient_address column (written before the send attempt).
 *
 * @param tenantId - Tenant UUID.
 * @param messageId - Message UUID (lifecycle_messages.id).
 * @param keyOverride - Optional signing key override (testing only).
 * @param options.topicId - Topic the one-click unsubscribe applies to (optional).
 * @returns URL-safe token string (no padding, no special chars).
 */
export function generateUnsubscribeToken(
  tenantId: string,
  messageId: string,
  keyOverride?: string,
  options?: { topicId?: string | null },
): string {
  const key = resolveKey(keyOverride);

  const payload: UnsubscribeTokenPayload = {
    tenantId,
    messageId,
    v: PAYLOAD_VERSION,
    ...(options?.topicId ? { topicId: options.topicId } : {}),
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(payloadBase64, key);
  const sigBase64 = sig.toString("base64url");

  return `${payloadBase64}.${sigBase64}`;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a stateless HMAC-signed unsubscribe token.
 *
 * Returns the decoded payload on success, or a typed error describing the
 * failure reason. The failure reasons are intentionally distinct so the
 * endpoint can log them internally, but the HTTP response must be the same
 * opaque error for all failure types to avoid leaking information.
 *
 * Uses timingSafeEqual for the signature comparison to prevent timing attacks.
 *
 * @param token - The raw token string from the URL.
 * @param keyOverride - Optional signing key override (testing only).
 * @returns { ok: true, payload } on success, { ok: false, error } on failure.
 */
export function verifyUnsubscribeToken(
  token: string,
  keyOverride?: string,
): { ok: true; payload: UnsubscribeTokenPayload } | { ok: false; error: UnsubscribeTokenError } {
  const key = resolveKey(keyOverride);

  // Step 1: structural check - must be two base64url segments separated by a single dot
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1 || dotIdx !== token.lastIndexOf(".")) {
    // No dot, or more than one dot -> malformed
    return { ok: false, error: { kind: "malformed" } };
  }

  const payloadBase64 = token.slice(0, dotIdx);
  const sigBase64 = token.slice(dotIdx + 1);

  if (payloadBase64.length === 0 || sigBase64.length === 0) {
    return { ok: false, error: { kind: "malformed" } };
  }

  // Step 2: constant-time signature verification
  // Re-compute the expected signature and compare with timingSafeEqual.
  const expectedSig = sign(payloadBase64, key);

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigBase64, "base64url");
  } catch {
    return { ok: false, error: { kind: "malformed" } };
  }

  if (expectedSig.length !== providedSig.length) {
    // Different lengths can't be equal. Still use a constant-time path:
    // compare against a dummy buffer to avoid length-leaking timing.
    timingSafeEqual(expectedSig, expectedSig);
    return { ok: false, error: { kind: "bad_signature" } };
  }

  const sigMatch = timingSafeEqual(expectedSig, providedSig);
  if (!sigMatch) {
    return { ok: false, error: { kind: "bad_signature" } };
  }

  // Step 3: decode and validate the payload JSON
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: { kind: "malformed" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: { kind: "malformed" } };
  }

  if (!isValidPayload(parsed)) {
    return { ok: false, error: { kind: "invalid_payload" } };
  }

  return { ok: true, payload: parsed };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type-guard for the token payload.
 */
function isValidPayload(val: unknown): val is UnsubscribeTokenPayload {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.v === PAYLOAD_VERSION &&
    typeof obj.tenantId === "string" &&
    obj.tenantId.length > 0 &&
    typeof obj.messageId === "string" &&
    obj.messageId.length > 0 &&
    (obj.topicId === undefined || (typeof obj.topicId === "string" && obj.topicId.length > 0))
  );
}
