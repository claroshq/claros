/**
 * Outbound webhook endpoints (G5), managed one by one: the dashboard
 * webhooks page and the management API. The same rows `PUT /v1/config`
 * writes (`webhooks[]`); every write bumps the product's config_version.
 *
 *   GET    /v1/webhooks                   endpoints (the analytics sink is listed read-only)
 *   POST   /v1/webhooks                   create; the signing secret is returned once
 *   PATCH  /v1/webhooks/:slug             url, events, enabled, batch_interval_minutes
 *   DELETE /v1/webhooks/:slug             delete (pending deliveries are dropped)
 *   POST   /v1/webhooks/:slug/rotate      new signing secret, returned once
 *   GET    /v1/webhooks/:slug/deliveries  the latest 50 deliveries, newest first
 *
 * Owner session or an admin key with the `config` scope. Secrets are stored
 * encrypted (ENCRYPTION_KEY) and never returned after creation or rotation.
 * The analytics sink (kind 'analytics', slug 'analytics') is settings.analytics
 * of the config document, changed with /v1/analytics-sink (analytics-sink.ts)
 * or a config apply: it is listed with its `sink`, and its deliveries can be
 * read, but these routes do not change it.
 */
import { z } from "zod";
import { storeFor } from "@claros/store";
import type { WebhookEndpointRow } from "@claros/store";
import { CONFIG_SLUG, WEBHOOK_EVENTS, generateWebhookSecret } from "@claros/core";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import type { Db } from "../plugins/db.js";
import type { AppContext } from "../http/env.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";

/** Default window of the batched message.pending_approval event, in minutes. */
export const DEFAULT_BATCH_INTERVAL_MINUTES = 15;

const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//.test(u), { message: "must be an http(s) URL" });
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1);
const batchInterval = z.number().int().min(1).max(1440);

const createSchema = z
  .object({
    slug: z.string().regex(CONFIG_SLUG, { message: "slug: 1-63 characters of a-z, 0-9, _ and -, starting with a letter or digit" }),
    url: httpUrl,
    events,
    enabled: z.boolean().optional(),
    batch_interval_minutes: batchInterval.optional(),
  })
  .strict();

const patchSchema = z
  .object({
    url: httpUrl.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
    batch_interval_minutes: batchInterval.nullable().optional(),
  })
  .strict();

function encryptionKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    return parseEncryptionKey(raw);
  } catch {
    return null;
  }
}

function noKey(c: AppContext): Response {
  return c.json({ error: "ENCRYPTION_KEY is not configured. Set it before storing webhook secrets." }, 503);
}

function validationError(c: AppContext, issues: z.ZodIssue[]): Response {
  return c.json({ error: "Validation failed", issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
}

function batchMinutes(config: Record<string, unknown> | null): number {
  const v = config?.batch_interval_minutes;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_BATCH_INTERVAL_MINUTES;
}

function serialize(e: WebhookEndpointRow) {
  return {
    id: e.id,
    slug: e.slug,
    kind: e.kind,
    url: e.url,
    events: e.events,
    enabled: e.enabled,
    batch_interval_minutes: batchMinutes(e.config),
    has_secret: e.hasSecret,
    read_only: e.kind !== "webhook",
    /** statsraven | webhook for the analytics sink; null for a webhook. */
    sink: e.kind === "analytics" ? (e.config?.sink === "webhook" ? "webhook" : "statsraven") : null,
    created_at: e.createdAt?.toISOString() ?? null,
    updated_at: e.updatedAt?.toISOString() ?? null,
  };
}

export default function webhookEndpointRoutes() {
  const r = new RoleRouter();

  r.get("/", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const rows = await storeFor(db).apiWebhooks.listEndpoints(c.var.tenant!.id);
    return c.json({ webhooks: rows.map(serialize), events: WEBHOOK_EVENTS });
  });

  r.post("/", "owner", allowAdminKey("config"), async (c) => {
    const parsed = createSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const key = encryptionKey();
    if (!key) return noKey(c);
    const body = parsed.data;
    if (body.slug === "analytics") {
      return c.json({ error: "The slug 'analytics' is reserved for the analytics sink (settings.analytics)." }, 400);
    }
    const secret = generateWebhookSecret();
    const db: Db = c.var.db;
    const row = await storeFor(db).apiWebhooks.createEndpoint({
      tenantId: c.var.tenant!.id,
      slug: body.slug,
      url: body.url,
      events: [...new Set(body.events)],
      enabled: body.enabled ?? true,
      config: body.batch_interval_minutes !== undefined ? { batch_interval_minutes: body.batch_interval_minutes } : null,
      secret: encrypt(secret, key),
      now: new Date(),
    });
    if (!row) return c.json({ error: `A webhook with the slug '${body.slug}' already exists.` }, 409);
    return c.json({ ...serialize(row), secret }, 201);
  });

  r.patch("/:slug", "owner", allowAdminKey("config"), async (c) => {
    const parsed = patchSchema.safeParse(c.var.body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const body = parsed.data;
    if (Object.keys(body).length === 0) return c.json({ error: "Nothing to update." }, 400);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const slug = c.req.param("slug")!;
    const existing = await storeFor(db).apiWebhooks.findEndpoint({ tenantId, slug });
    if (!existing) return c.json({ error: "Webhook not found." }, 404);
    if (existing.kind !== "webhook") return c.json({ error: "The analytics sink is changed with /v1/analytics-sink or settings.analytics." }, 409);
    let config: Record<string, unknown> | null | undefined;
    if (body.batch_interval_minutes !== undefined) {
      const { batch_interval_minutes: _old, ...rest } = existing.config ?? {};
      config = body.batch_interval_minutes === null ? (Object.keys(rest).length > 0 ? rest : null) : { ...rest, batch_interval_minutes: body.batch_interval_minutes };
    }
    const row = await storeFor(db).apiWebhooks.updateEndpoint({
      tenantId,
      slug,
      patch: {
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { events: [...new Set(body.events)] } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(config !== undefined ? { config } : {}),
      },
      now: new Date(),
    });
    if (!row) return c.json({ error: "Webhook not found." }, 404);
    return c.json(serialize(row));
  });

  r.delete("/:slug", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const slug = c.req.param("slug")!;
    const existing = await storeFor(db).apiWebhooks.findEndpoint({ tenantId, slug });
    if (!existing) return c.json({ error: "Webhook not found." }, 404);
    if (existing.kind !== "webhook") return c.json({ error: "The analytics sink is changed with /v1/analytics-sink or settings.analytics." }, 409);
    await storeFor(db).apiWebhooks.deleteEndpoint({ tenantId, slug, now: new Date() });
    return c.json({ success: true });
  });

  r.post("/:slug/rotate", "owner", allowAdminKey("config"), async (c) => {
    const key = encryptionKey();
    if (!key) return noKey(c);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const slug = c.req.param("slug")!;
    const existing = await storeFor(db).apiWebhooks.findEndpoint({ tenantId, slug });
    if (!existing) return c.json({ error: "Webhook not found." }, 404);
    if (existing.kind !== "webhook") return c.json({ error: "The analytics sink is changed with /v1/analytics-sink or settings.analytics." }, 409);
    const secret = generateWebhookSecret();
    const row = await storeFor(db).apiWebhooks.updateEndpoint({ tenantId, slug, patch: { secret: encrypt(secret, key) }, now: new Date() });
    if (!row) return c.json({ error: "Webhook not found." }, 404);
    return c.json({ ...serialize(row), secret });
  });

  r.get("/:slug/deliveries", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const existing = await storeFor(db).apiWebhooks.findEndpoint({ tenantId, slug: c.req.param("slug")! });
    if (!existing) return c.json({ error: "Webhook not found." }, 404);
    const rows = await storeFor(db).apiWebhooks.listDeliveries({ tenantId, endpointId: existing.id, limit: 50 });
    return c.json({
      deliveries: rows.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        next_attempt_at: d.nextAttemptAt.toISOString(),
        last_error: d.lastError,
        created_at: d.createdAt.toISOString(),
        delivered_at: d.deliveredAt?.toISOString() ?? null,
        payload: d.payload,
      })),
    });
  });

  return r.app;
}
