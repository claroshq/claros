/**
 * Outbound webhooks (G5) and the analytics sink (G30): event names, the
 * analytics mapping, retry backoff and Standard Webhooks signatures.
 *
 * Signatures follow Standard Webhooks (https://www.standardwebhooks.com):
 * headers webhook-id, webhook-timestamp (unix seconds) and
 * webhook-signature "v1,<base64 HMAC-SHA256 of `${id}.${timestamp}.${body}`>",
 * keyed with the base64 part of a `whsec_` secret.
 */
import { createHmac, randomBytes } from "node:crypto";

/** Events a webhook endpoint can subscribe to. */
export const WEBHOOK_EVENTS = [
  "message.sent",
  "message.delivered",
  "message.opened",
  "message.clicked",
  "message.bounced",
  "message.complained",
  "message.failed",
  "message.pending_approval",
  "contact.subscribed",
  "contact.unsubscribed",
  "contact.resubscribed",
  "contact.suppressed",
  "flow.enrolled",
  "flow.exited",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Internal events written to the outbox for the analytics sink only. */
export const INTERNAL_EVENTS = ["message.approved", "message.rejected", "choose.decided"] as const;
export type OutboxEventName = WebhookEvent | (typeof INTERNAL_EVENTS)[number];

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

/**
 * Analytics sink events (G30), keyed by the outbox event they come from.
 * No open events: opens are unreliable (privacy proxies) and noisy.
 */
export const ANALYTICS_EVENT_MAP: Readonly<Record<string, string>> = {
  "flow.enrolled": "flow_enrolled",
  "flow.exited": "flow_exited",
  "message.sent": "email_sent",
  "message.clicked": "email_clicked",
  "message.bounced": "email_bounced",
  "message.complained": "email_complained",
  "contact.unsubscribed": "email_unsubscribed",
  "message.approved": "approval_decided",
  "message.rejected": "approval_decided",
  "choose.decided": "choose_decided",
};

/** A person trait value an analytics event carries. */
export type AnalyticsTraitValue = string | number;

/**
 * Who the user of an analytics event is (G30), sent as `traits` next to
 * `user_id` so the analytics tool can name the person. Only values the
 * contact really has: a missing, blank or non-scalar value leaves its key
 * out (an empty value would erase what the tool already knows). Keys:
 * email, name, company (the contact's own fields) and plan (the product's
 * `plan` property). null when nothing is known.
 */
export function analyticsTraits(contact: {
  email: string | null;
  name: string | null;
  company: string | null;
  properties?: Record<string, unknown> | null;
}): Record<string, AnalyticsTraitValue> | null {
  const out: Record<string, AnalyticsTraitValue> = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === "string") {
      const v = value.trim();
      if (v) out[key] = v;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  };
  put("email", contact.email);
  put("name", contact.name);
  put("company", contact.company);
  put("plan", contact.properties?.plan);
  return Object.keys(out).length > 0 ? out : null;
}

/** The outbox events an analytics sink endpoint receives. */
export const ANALYTICS_SOURCE_EVENTS: readonly string[] = Object.keys(ANALYTICS_EVENT_MAP);

export const ANALYTICS_SINKS = ["statsraven", "webhook"] as const;
export type AnalyticsSink = (typeof ANALYTICS_SINKS)[number];

/** Slug of a product's analytics sink endpoint (kind 'analytics'). */
export const ANALYTICS_ENDPOINT_SLUG = "analytics";

/** Window of the batched message.pending_approval event (G14). */
export const PENDING_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Dedup key and delivery time of a pending-approval ping: one per product
 * and endpoint per aligned 15-minute window, delivered at the window's end,
 * so a product gets at most one ping per 15 minutes covering every message
 * that entered the queue in that window.
 */
export function pendingApprovalBatch(now: Date, intervalMinutes = 15): { dedupKey: string; deliverAt: Date } {
  const minutes = Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440 ? intervalMinutes : 15;
  const windowMs = minutes * 60_000;
  const end = Math.ceil((now.getTime() + 1) / windowMs) * windowMs;
  return { dedupKey: `message.pending_approval:${end}`, deliverAt: new Date(end) };
}

/** P5b: an endpoint's pending-approval batch window (webhook_endpoints.config.batch_interval_minutes, default 15). */
export function endpointBatchMinutes(config: unknown): number {
  const v = config && typeof config === "object" ? (config as { batch_interval_minutes?: unknown }).batch_interval_minutes : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440 ? v : 15;
}

/** Delivery attempts before an outbox row is dead. */
export const WEBHOOK_MAX_ATTEMPTS = 12;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 12 * 60 * 60_000;

/**
 * Delay before the next attempt after `attempts` failed ones (1-based):
 * 1 minute, doubling, capped at 12 hours. null = give up (dead).
 */
export function webhookBackoffMs(attempts: number): number | null {
  if (attempts >= WEBHOOK_MAX_ATTEMPTS) return null;
  return Math.min(BACKOFF_MIN_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

/** A new signing secret in the Standard Webhooks format. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** Standard Webhooks headers for one delivery. */
export function signWebhook(input: { id: string; timestamp: Date; body: string; secret: string }): Record<string, string> {
  const seconds = Math.floor(input.timestamp.getTime() / 1000);
  const key = Buffer.from(input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret, "base64");
  const signature = createHmac("sha256", key).update(`${input.id}.${seconds}.${input.body}`).digest("base64");
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(seconds),
    "webhook-signature": `v1,${signature}`,
  };
}

/** Verify Standard Webhooks headers (receivers and tests). Constant time. */
export function verifyWebhook(input: { headers: Record<string, string | undefined>; body: string; secret: string; toleranceSeconds?: number; now?: Date }): boolean {
  const id = input.headers["webhook-id"];
  const ts = input.headers["webhook-timestamp"];
  const sig = input.headers["webhook-signature"];
  if (!id || !ts || !sig) return false;
  const seconds = Number(ts);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > (input.toleranceSeconds ?? 300)) return false;
  const expected = signWebhook({ id, timestamp: new Date(seconds * 1000), body: input.body, secret: input.secret })["webhook-signature"]!;
  const expectedBuf = Buffer.from(expected.slice(3));
  return sig.split(" ").some((part) => {
    if (!part.startsWith("v1,")) return false;
    const got = Buffer.from(part.slice(3));
    if (got.length !== expectedBuf.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i]! ^ expectedBuf[i]!;
    return diff === 0;
  });
}
