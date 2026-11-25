/**
 * Outbound webhook and analytics delivery (G5, G30).
 *
 * The outbox rows are written by the state changes themselves (store
 * methods, same atomic unit). This tick claims due rows, builds the request
 * per endpoint kind and records the outcome:
 *
 *   - kind 'webhook': POST JSON {type, timestamp, data} signed with Standard
 *     Webhooks headers (webhook-id = outbox row id, so receivers dedupe on
 *     it; delivery is at least once).
 *   - kind 'analytics', sink 'statsraven': POST {endpoint}/ingest?source=claros
 *     with the ingest token as Bearer, one flat event (G30 names, keyed by
 *     user_id = the contact's external_id). StatsRaven's server ingest API.
 *   - kind 'analytics', sink 'webhook': the same flat event as JSON, signed
 *     like a webhook when a secret is set.
 *
 * 2xx = delivered. Anything else, a timeout or a network error = retry with
 * backoff (1 minute doubling to 12 hours), dead after WEBHOOK_MAX_ATTEMPTS.
 * Delivery never touches the send path: a slow receiver only delays its own
 * rows.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor, type WebhookDeliveryRow, type WebhookSubject } from "@claros/store";
import { ANALYTICS_EVENT_MAP, signWebhook, webhookBackoffMs } from "@claros/core";
import { decrypt, parseEncryptionKey } from "@claros/adapters";

type Db = NodePgDatabase<Record<string, never>>;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface WebhookTickDeps {
  /** HTTP client (tests pass a fake). Default: global fetch. */
  fetch?: FetchFn;
  /** ENCRYPTION_KEY value; default process.env.ENCRYPTION_KEY. */
  encryptionKey?: string;
  /** Rows per tick (default 50). */
  limit?: number;
  /** Per-request timeout in ms (default 10 s). */
  timeoutMs?: number;
}

export interface WebhookTickResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

/** A claim is retried after this lease if the tick dies mid-delivery. */
const LEASE_MS = 5 * 60_000;

export async function processWebhookTick(db: Db, now: Date, deps: WebhookTickDeps = {}): Promise<WebhookTickResult> {
  const store = storeFor(db).workerWebhooks;
  const rows = await store.claimDueDeliveries({ now, limit: deps.limit ?? 50, leaseMs: LEASE_MS });
  const result: WebhookTickResult = { claimed: rows.length, delivered: 0, retried: 0, dead: 0 };
  for (const row of rows) {
    const outcome = await deliverOne(db, row, deps);
    if (outcome === null) {
      await store.markDelivered({ id: row.id, now: new Date() });
      result.delivered++;
      continue;
    }
    const delay = outcome.permanent ? null : webhookBackoffMs(row.attempts);
    await store.markAttemptFailed({
      id: row.id,
      error: outcome.error,
      nextAttemptAt: delay === null ? null : new Date(Date.now() + delay),
      now: new Date(),
    });
    if (delay === null) result.dead++;
    else result.retried++;
  }
  return result;
}

/** null = delivered; otherwise the error (permanent = no retry). */
async function deliverOne(db: Db, row: WebhookDeliveryRow, deps: WebhookTickDeps): Promise<{ error: string; permanent?: boolean } | null> {
  if (!row.endpoint) return { error: "endpoint removed or disabled", permanent: true };
  let secret: string | null = null;
  if (row.endpoint.secret) {
    try {
      secret = decryptSecret(row.endpoint.secret, deps.encryptionKey);
    } catch (err) {
      return { error: `secret: ${(err as Error).message}` };
    }
  }
  const subject = await storeFor(db).workerWebhooks.describeSubject({
    tenantId: row.tenantId,
    messageId: str(row.payload.message_id),
    membershipId: str(row.payload.membership_id),
    contactId: str(row.payload.contact_id),
    flowId: str(row.payload.flow_id),
    email: str(row.payload.email),
  });
  const extra: Record<string, unknown> = {};
  if (row.event === "message.pending_approval") {
    extra.pending_count = await storeFor(db).workerWebhooks.countPendingApprovals(row.tenantId);
  }

  const request = row.endpoint.kind === "analytics"
    ? analyticsRequest(row, subject, secret)
    : webhookRequest(row, subject, secret, extra);
  if (!request) return null; // nothing to send for this event (e.g. unmapped analytics event)

  const doFetch: FetchFn = deps.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: controller.signal });
    if (res.status >= 200 && res.status < 300) return null;
    const text = await res.text().catch(() => "");
    return { error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  } catch (err) {
    return { error: controller.signal.aborted ? "timeout" : (err as Error).message || "network error" };
  } finally {
    clearTimeout(timer);
  }
}

function decryptSecret(envelope: string, keyEnv: string | undefined): string {
  const key = keyEnv ?? process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY not configured");
  return decrypt(envelope, parseEncryptionKey(key));
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The JSON body of a webhook event (stable, documented in docs/guide/WEBHOOKS.md). */
export function webhookBody(row: Pick<WebhookDeliveryRow, "event" | "tenantSlug" | "payload" | "createdAt">, subject: WebhookSubject, extra: Record<string, unknown> = {}) {
  const p = row.payload;
  const data: Record<string, unknown> = { product: row.tenantSlug };
  if (subject.contact) data.contact = { external_id: subject.contact.externalId, email: subject.contact.email };
  else if (str(p.email)) data.contact = { external_id: null, email: p.email };
  if (subject.message) {
    data.message = {
      id: subject.message.id,
      subject: subject.message.subject,
      action_type: subject.message.actionType,
      step: subject.message.step,
      topic: subject.topic?.slug ?? null,
    };
  }
  if (subject.flow) data.flow = { id: subject.flow.id, slug: subject.flow.slug, name: subject.flow.name };
  for (const k of ["reason", "scope", "topic", "source", "decision", "previous_reason"]) {
    if (p[k] !== undefined && p[k] !== null) data[k] = p[k];
  }
  if (str(p.membership_id)) data.membership_id = p.membership_id;
  Object.assign(data, extra);
  return { type: row.event, timestamp: row.createdAt.toISOString(), data };
}

function webhookRequest(row: WebhookDeliveryRow, subject: WebhookSubject, secret: string | null, extra: Record<string, unknown>) {
  const body = JSON.stringify(webhookBody(row, subject, extra));
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Claros-Webhooks" };
  if (secret) Object.assign(headers, signWebhook({ id: row.id, timestamp: new Date(), body, secret }));
  else headers["webhook-id"] = row.id;
  return { url: row.endpoint!.url, headers, body };
}

/** The flat analytics event (G30), or null when the outbox event has no analytics name. */
export function analyticsEvent(row: Pick<WebhookDeliveryRow, "event" | "tenantSlug" | "payload" | "createdAt">, subject: WebhookSubject): Record<string, unknown> | null {
  const name = ANALYTICS_EVENT_MAP[row.event];
  if (!name) return null;
  const p = row.payload;
  const ev: Record<string, unknown> = {
    event: name,
    ts: row.createdAt.toISOString(),
    user_id: subject.contact?.externalId ?? null,
    product: row.tenantSlug,
  };
  if (subject.message) {
    ev.message_id = subject.message.id;
    if (subject.message.actionType) ev.action_type = subject.message.actionType;
    if (subject.message.step !== null) ev.step = subject.message.step;
  }
  if (subject.flow) ev.flow = subject.flow.slug ?? subject.flow.name;
  if (subject.topic) ev.topic = subject.topic.slug;
  if (row.event === "flow.exited") ev.reason = p.reason ?? null;
  if (row.event === "message.approved" || row.event === "message.rejected") ev.decision = row.event === "message.approved" ? "approved" : "rejected";
  if (row.event === "contact.unsubscribed") {
    ev.scope = p.scope ?? null;
    if (p.topic) ev.topic = p.topic;
  }
  if (row.event === "choose.decided") {
    ev.choice = p.choice ?? null;
    ev.reason = p.reason ?? null;
  }
  return ev;
}

function analyticsRequest(row: WebhookDeliveryRow, subject: WebhookSubject, secret: string | null) {
  const ev = analyticsEvent(row, subject);
  if (!ev) return null;
  const body = JSON.stringify(ev);
  const sink = row.endpoint!.config?.sink === "webhook" ? "webhook" : "statsraven";
  if (sink === "statsraven") {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Claros-Analytics" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    return { url: statsravenIngestUrl(row.endpoint!.url), headers, body };
  }
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Claros-Analytics" };
  if (secret) Object.assign(headers, signWebhook({ id: row.id, timestamp: new Date(), body, secret }));
  else headers["webhook-id"] = row.id;
  return { url: row.endpoint!.url, headers, body };
}

/** https://stats.example.com -> https://stats.example.com/ingest?source=claros (an explicit /ingest path is kept). */
export function statsravenIngestUrl(endpoint: string): string {
  const u = new URL(endpoint);
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/ingest";
  if (!u.searchParams.has("source")) u.searchParams.set("source", "claros");
  return u.toString();
}
