/**
 * Resend webhook endpoint - public, unauthenticated by session.
 *
 * Receives email event notifications from Resend (bounces, opens, clicks,
 * complaints, deliveries, etc.) and:
 *   1. Resolves the tenant from the URL path (:tenantId).
 *   2. Loads the webhook signing secret from that tenant's transport
 *      configuration (transport_configs.config, decrypted with ENCRYPTION_KEY).
 *   3. Verifies the Svix signature (HMAC-SHA256) before parsing the body.
 *   4. Correlates the event to an internal lifecycle_messages row via
 *      provider_message_id, scoped to the path tenant.
 *   5. Advances the feedback column using advance-only CAS transitions.
 *   6. Writes suppression rows on permanent bounces and complaints.
 *
 * Path shape:
 *   POST /webhooks/resend/:tenantId
 *
 *   :tenantId is the UUID of the tenant whose Resend account issued the event.
 *   Resend must be configured to send webhooks to this URL. Each tenant's
 *   account issues its own signing secret stored in that tenant's
 *   transport_configs.config as { apiKey, webhookSecret }.
 *
 * Ordering constraint (signature-before-parse):
 *   Signature verification must happen before the body is parsed, but the
 *   tenant is only known from the body. Carrying the tenant in the URL path
 *   resolves this: the tenant is known from the path before the body is
 *   touched, so the correct secret is loaded before any JSON parsing.
 *
 * Signature verification:
 *   Resend uses the Svix infrastructure. Every webhook request carries three
 *   headers: svix-id, svix-timestamp, svix-signature. The signed content is
 *   `${svix-id}.${svix-timestamp}.${rawBody}` signed with HMAC-SHA256 using
 *   the base64-decoded portion of the webhook secret (after the "whsec_" prefix).
 *   Timestamp tolerance: 5 minutes (300 seconds). Requests older than this are
 *   rejected to prevent replay attacks.
 *
 * Tenant resolution failures:
 *   If the tenant UUID does not exist, has no active transport configuration,
 *   or has one with no webhookSecret, the request is rejected with 400 and the
 *   same generic message as a bad signature. This prevents the path from being
 *   used as an oracle for which tenant IDs exist.
 *
 * No global fallback:
 *   There is no RESEND_WEBHOOK_SECRET environment variable fallback.
 *   A global secret is unsafe in a multi-tenant model: one tenant's path could
 *   accept events signed by another tenant's secret if both fall back to the
 *   same global key. Verification requires a per-tenant secret stored in the
 *   tenant's configuration; if absent, the request is rejected.
 *
 * Cross-tenant enforcement:
 *   After signature verification, the message lookup is scoped to the path
 *   tenant: WHERE provider_message_id = :emailId AND tenant_id = :pathTenantId.
 *   This ensures a valid signature from tenant A cannot touch tenant B's
 *   messages even if the provider message ID is guessed or reused.
 *
 * Bounce classification:
 *   Resend's bounce payload includes `bounce.type` which is "Permanent" or
 *   "Temporary". Only "Permanent" bounces suppress. If the type field is
 *   absent or unrecognized, the bounce is treated as temporary (no suppression)
 *   because suppressing on uncertain data would false-positive block addresses.
 *
 * Suppression address source:
 *   The address suppressed ALWAYS comes from the resolved message row's
 *   recipient_address column, never from the webhook payload. This prevents
 *   a forged or replayed webhook from suppressing arbitrary addresses.
 *
 * Unknown event types:
 *   Acknowledged with 200 and ignored. Returning a non-2xx would cause Resend
 *   to retry indefinitely.
 */
import { createRouter, parseBody } from "../../http/router.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { storeFor } from "@claros/store";
import { recordWebhookFailure } from "../../ops-events.js";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import type { Db } from "../../plugins/db.js";

// ---------------------------------------------------------------------------
// Event logging constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of event rows stored per message. Beyond this, new events
 * are silently dropped. This bounds growth from sources we do not control
 * (e.g. pixel-loaded opens on email clients that re-render on every view).
 */
const MAX_EVENTS_PER_MESSAGE = 50;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age of a webhook timestamp before it is rejected (in seconds).
 * Prevents replay of previously valid payloads.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Feedback state ordinals for advance-only transitions.
 * Higher number = more advanced state. Terminal states (bounced, complained)
 * override any non-terminal state.
 */
const FEEDBACK_ORDINALS: Record<string, number> = {
  opened: 1,
  clicked: 2,
  bounced: 99,
  complained: 99,
};

/**
 * For non-terminal advancement: the CAS WHERE clause requires the current
 * feedback to be one of these predecessor states.
 */
const ADVANCE_PREDECESSORS: Record<string, (string | null)[]> = {
  // NULL -> opened: first engagement
  // (no backward from clicked)
  opened: [null],
  // NULL -> clicked: click without tracked open (some clients)
  // opened -> clicked: normal advancement
  clicked: [null, "opened"],
};

// ---------------------------------------------------------------------------
// Tenant secret resolution
// ---------------------------------------------------------------------------

/** Shape of the decrypted credentials stored in transport_configs.config. */
interface TransportCredentials {
  apiKey: string;
  webhookSecret?: string;
}

/**
 * Load the webhook signing secret for the given tenant from their active
 * Resend transport configuration.
 *
 * Returns the secret string (e.g. "whsec_...") if found, or null if:
 *   - The tenant UUID does not exist (no rows for that tenant)
 *   - The tenant has no active transport configuration
 *   - The provider is not 'resend'
 *   - The decrypted config has no webhookSecret field
 *   - ENCRYPTION_KEY is not set or decryption fails
 *
 * In all null cases the caller returns the same generic 400 - the caller
 * must not distinguish between these cases to avoid being an oracle.
 */
async function loadTenantWebhookSecret(
  db: Db,
  tenantId: string,
): Promise<string | null> {
  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return null;
  }

  let key: Buffer;
  try {
    key = parseEncryptionKey(encryptionKeyEnv);
  } catch {
    return null;
  }

  let config: string | null;
  try {
    config = await storeFor(db).apiResendWebhook.findActiveResendConfig(tenantId);
  } catch {
    // UUID cast will throw if tenantId is not a valid UUID format.
    // Treat the same as "not found" - same 400 response.
    return null;
  }

  if (config === null) {
    return null;
  }

  let credentials: TransportCredentials;
  try {
    const decrypted = decrypt(config, key);
    credentials = JSON.parse(decrypted) as TransportCredentials;
  } catch {
    return null;
  }

  return credentials.webhookSecret ?? null;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean;
}

/**
 * Verify the Svix webhook signature.
 *
 * The signed content is: `${svixId}.${svixTimestamp}.${rawBody}`
 * The signature is HMAC-SHA256 using the base64-decoded webhook secret.
 * The svix-signature header may contain multiple signatures separated by spaces,
 * each prefixed with a version identifier (e.g. "v1,").
 *
 * Returns { ok: true } only if:
 *   1. All required headers are present
 *   2. The timestamp is within tolerance
 *   3. At least one v1 signature matches
 */
export function verifyResendWebhookSignature(
  rawBody: string,
  svixId: string | undefined,
  svixTimestamp: string | undefined,
  svixSignature: string | undefined,
  secret: string,
  nowSeconds?: number,
): VerifyResult {
  if (!svixId || !svixTimestamp || !svixSignature || !secret) {
    return { ok: false };
  }

  // Verify timestamp freshness
  const timestampNum = parseInt(svixTimestamp, 10);
  if (isNaN(timestampNum)) {
    return { ok: false };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = Math.abs(now - timestampNum);
  if (age > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false };
  }

  // Extract the base64 key from the secret (strip "whsec_" prefix if present)
  const secretBase64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretBase64, "base64");

  // Construct signed content
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;

  // Compute expected signature
  const expectedSignature = createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  // Check each signature in the header (space-delimited, version-prefixed)
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const parts = sig.split(",");
    if (parts.length < 2) continue;
    const version = parts[0];
    const sigValue = parts.slice(1).join(","); // rejoin in case base64 has no commas, but be safe

    if (version !== "v1") continue;

    // Constant-time comparison
    const sigBuf = Buffer.from(sigValue, "base64");
    const expectedBuf = Buffer.from(expectedSignature, "base64");

    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Feedback advance-only update
// ---------------------------------------------------------------------------

/**
 * Advance the feedback column on a lifecycle_messages row using CAS.
 *
 * Legal transitions (from BACKLOG.md):
 *   NULL -> opened (first open)
 *   NULL -> clicked (click without tracked open)
 *   opened -> clicked
 *   Any state -> bounced (terminal, overwrite allowed)
 *   Any state -> complained (terminal, overwrite allowed)
 *
 * Illegal (no-op by CAS):
 *   clicked -> opened (backward)
 *   any non-terminal -> NULL (backward)
 *   bounced -> anything (absorbing)
 *   complained -> anything (absorbing)
 *
 * Returns true if the row was updated, false if the CAS condition was not met
 * (meaning the row was already at an equal or more advanced state).
 */
export async function advanceFeedback(
  db: Db,
  messageId: string,
  newFeedback: "opened" | "clicked" | "bounced" | "complained",
): Promise<boolean> {
  const isTerminal = newFeedback === "bounced" || newFeedback === "complained";

  if (isTerminal) {
    // Terminal states override anything except another terminal.
    return storeFor(db).apiResendWebhook.setTerminalFeedback({ messageId, feedback: newFeedback });
  }

  // Non-terminal: advance-only via predecessors
  const predecessors = ADVANCE_PREDECESSORS[newFeedback];
  if (!predecessors) {
    return false; // Unknown feedback value
  }

  // CAS: feedback IS NULL OR feedback IN (predecessors excluding null)
  return storeFor(db).apiResendWebhook.advanceFeedback({
    messageId,
    feedback: newFeedback,
    predecessors,
  });
}

// ---------------------------------------------------------------------------
// Suppression write helper
// ---------------------------------------------------------------------------

/**
 * Write a suppression row. Idempotent via ON CONFLICT DO NOTHING
 * on the functional unique index (tenant_id, lower(email)).
 *
 * The email is normalized to lowercase before insertion.
 */
async function writeSuppression(
  db: Db,
  tenantId: string,
  email: string,
  reason: "hard_bounce" | "complaint",
): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  await storeFor(db).apiResendWebhook.insertSuppression({ tenantId, email: normalizedEmail, reason });
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

/** Resend webhook event payload shape (subset we use). */
interface ResendWebhookEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: {
      type?: string;
      subType?: string;
      message?: string;
    };
    click?: {
      url?: string;
    };
    [key: string]: unknown;
  };
}

/**
 * Process a verified Resend webhook event, scoped to the given tenant.
 *
 * Cross-tenant enforcement: the message lookup includes tenant_id = pathTenantId.
 * A provider_message_id that belongs to a different tenant will resolve to zero
 * rows and be acknowledged without processing, identical to an unknown message ID.
 *
 * Event logging: every recognized event type is written to message_events for the
 * sent-mail log timeline, in addition to advancing the feedback column. The event
 * table insert uses ON CONFLICT DO NOTHING on (tenant_id, provider_event_id) so
 * provider webhook retries are idempotent. A per-message cap (MAX_EVENTS_PER_MESSAGE)
 * bounds growth from sources we do not control.
 *
 * Returns a status object describing what happened (for testing/logging).
 */
export async function processResendWebhookEvent(
  db: Db,
  event: ResendWebhookEvent,
  tenantId: string,
  providerEventId?: string,
): Promise<{ action: string; messageId?: string }> {
  const eventType = event.type;
  const emailId = event.data?.email_id;

  // Only handle email events with an email_id we can correlate
  if (!emailId) {
    return { action: "ignored_no_email_id" };
  }

  // Map event type to our internal event_type and feedback value
  let logEventType: string | null = null;
  let feedback: "opened" | "clicked" | "bounced" | "complained" | null = null;
  let shouldSuppress = false;
  let suppressionReason: "hard_bounce" | "complaint" = "hard_bounce";
  let eventMetadata: Record<string, unknown> | null = null;

  switch (eventType) {
    case "email.delivered":
      // Delivery confirmation - no feedback column change needed
      // (feedback tracks engagement, not delivery), but we log the event.
      logEventType = "delivered";
      break;

    case "email.opened":
      logEventType = "opened";
      feedback = "opened";
      break;

    case "email.clicked":
      logEventType = "clicked";
      feedback = "clicked";
      // Capture click URL if provided
      if (event.data?.click?.url) {
        eventMetadata = { url: event.data.click.url };
      }
      break;

    case "email.bounced": {
      logEventType = "bounced";
      feedback = "bounced";
      const bounceType = event.data?.bounce?.type;
      const bounceSubType = event.data?.bounce?.subType;
      const bounceMessage = event.data?.bounce?.message;
      eventMetadata = {
        ...(bounceType && { bounce_type: bounceType }),
        ...(bounceSubType && { bounce_sub_type: bounceSubType }),
        ...(bounceMessage && { bounce_message: bounceMessage }),
      };
      if (Object.keys(eventMetadata).length === 0) eventMetadata = null;
      // Only suppress on permanent bounces
      if (bounceType === "Permanent") {
        shouldSuppress = true;
        suppressionReason = "hard_bounce";
      }
      break;
    }

    case "email.complained":
      logEventType = "complained";
      feedback = "complained";
      shouldSuppress = true;
      suppressionReason = "complaint";
      break;

    default:
      // Unknown or unhandled event type (email.sent, email.delivery_delayed,
      // email.scheduled, domain.*, contact.*, suppression.*, etc.)
      // Acknowledge without processing to prevent retries.
      return { action: "ignored_unhandled_type" };
  }

  // Resolve the internal message by provider_message_id, scoped to the
  // path tenant. This prevents a valid signature from one tenant from
  // touching another tenant's messages via a known provider_message_id.
  const message = await storeFor(db).apiResendWebhook.findMessageByProviderId({
    tenantId,
    providerMessageId: emailId,
  });

  if (!message) {
    // Unknown provider message ID for this tenant - acknowledge without error.
    // This can happen for emails sent before Claros was integrated,
    // for messages that were purged, or for events belonging to another tenant.
    // Do not return an error status because that would cause Resend to retry.
    return { action: "ignored_unknown_message" };
  }

  // Advance feedback (only for engagement/terminal events, not delivery)
  if (feedback) {
    await advanceFeedback(db, message.id, feedback);
  }

  // Write event to message_events table (all event types including delivery).
  // Respects per-message cap and provider-level deduplication.
  if (logEventType) {
    await writeMessageEvent(
      db,
      tenantId,
      message.id,
      logEventType,
      event.created_at ?? new Date().toISOString(),
      providerEventId ?? null,
      eventMetadata,
    );
  }

  // Write suppression if needed (address from message row, NOT from payload)
  if (shouldSuppress && message.recipientAddress) {
    await writeSuppression(
      db,
      message.tenantId,
      message.recipientAddress, // Always from the resolved message, never from payload
      suppressionReason,
    );
  }

  return { action: "processed", messageId: message.id };
}

/**
 * Write a delivery event to the message_events table.
 *
 * Idempotency: ON CONFLICT DO NOTHING on (tenant_id, provider_event_id).
 * Growth bound: checks existing event count for the message and skips if at cap.
 */
async function writeMessageEvent(
  db: Db,
  tenantId: string,
  messageId: string,
  eventType: string,
  occurredAt: string,
  providerEventId: string | null,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  // Enforce per-message cap to bound growth from repeated opens/clicks.
  const currentCount = await storeFor(db).apiResendWebhook.countMessageEvents(messageId);
  if (currentCount >= MAX_EVENTS_PER_MESSAGE) {
    return; // Silently drop - cap reached
  }

  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  await storeFor(db).apiResendWebhook.insertMessageEvent({
    tenantId,
    messageId,
    eventType,
    occurredAt,
    providerEventId,
    metadataJson,
  });
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

/**
 * Resend webhook route.
 *
 * Registered as a public route (no session auth).
 * Path: POST /webhooks/resend/:tenantId
 *
 * The :tenantId path parameter identifies which tenant's transport
 * configuration (and therefore which webhook signing secret) to use.
 * This allows each tenant to connect their own Resend account, each
 * issuing a distinct signing secret, without any global secret fallback.
 */
export default function resendWebhookRoutes() {
  const app = createRouter();

  // We need the raw body for signature verification.
  // Use a content type parser that preserves the raw body.
  const rawJsonBody = parseBody({
    parsers: { "application/json": (raw) => raw },
  });

  app.post("/:tenantId", rawJsonBody, async (c) => {
    if (!c.var.db) {
      return c.json({ error: "Service unavailable." }, 503);
    }

    const db: Db = c.var.db;
    const tenantId = c.req.param("tenantId");
    const rawBody = c.var.body as string;

    // Step 1: Load the webhook secret for this tenant BEFORE parsing the body.
    // This resolves the ordering constraint: we need the secret before
    // verification, but the tenant is carried in the path (not the body),
    // so we can load it here without touching the body first.
    //
    // loadTenantWebhookSecret returns null for all failure modes:
    //   - unknown tenant UUID
    //   - invalid UUID format
    //   - no active resend transport_config
    //   - transport_config has no webhookSecret field
    //   - ENCRYPTION_KEY not set or decryption error
    //
    // All null cases return the same generic 400, preventing the path from
    // being used as an oracle for which tenant IDs exist.
    const webhookSecret = await loadTenantWebhookSecret(db, tenantId);
    if (!webhookSecret) {
      // Respond identically to a signature mismatch - no information about why.
      return c.json({ error: "Invalid webhook signature." }, 400);
    }

    // Step 2: Extract Svix headers
    const svixId = c.req.header("svix-id");
    const svixTimestamp = c.req.header("svix-timestamp");
    const svixSignature = c.req.header("svix-signature");

    // Step 3: Verify signature against the tenant's secret (before JSON.parse)
    const verification = verifyResendWebhookSignature(
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
      webhookSecret,
    );

    // Failures from here on are counted for the product's alert (G25): its
    // secret exists, so the path names a real, configured product.
    if (!verification.ok) {
      await recordWebhookFailure(db, tenantId, "signature");
      return c.json({ error: "Invalid webhook signature." }, 400);
    }

    // Step 4: Parse the verified payload
    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(rawBody) as ResendWebhookEvent;
    } catch {
      await recordWebhookFailure(db, tenantId, "payload");
      return c.json({ error: "Invalid JSON payload." }, 400);
    }

    // Step 5: Process the event, scoped to this tenant
    try {
      await processResendWebhookEvent(db, event, tenantId, svixId);
    } catch (err) {
      await recordWebhookFailure(db, tenantId, "processing");
      throw err;
    }

    // Always return 200 to acknowledge receipt (even for ignored events)
    return c.json({ received: true }, 200);
  });

  return app;
}
