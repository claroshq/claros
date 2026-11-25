/**
 * Instance administration (instance admins only).
 *
 * Endpoints:
 *   GET  /v1/instance                              { settings, users }
 *   PUT  /v1/instance/settings/:key                { value } -> { key, value, updated_at }
 *   GET  /v1/instance/health                       open alerts, recent events, last run per
 *                                                  periodic job, failed-job count, alert settings
 *   POST /v1/instance/alerts/:fingerprint/resolve  -> { alert }
 *   POST /v1/instance/alerts/:fingerprint/mute     { hours } -> { alert }
 *
 * Instance settings are key/value JSON shared by every product of the
 * instance. Users are listed with their home product and memberships.
 * The alert settings (alerts.email, alerts.enabled, alerts.via_product)
 * are validated on PUT; alerts.email and alerts.via_product accept "" for
 * "use the default".
 */
import { z } from "zod";
import {
  ALERT_SETTING,
  OPS_KIND,
  QUEUE,
  TICK_INTERVAL_MINUTES,
  TICK_LATE_FACTOR,
  tickName,
} from "@claros/core";
import { storeFor, type OpsAlertRow, type OpsEventRow } from "@claros/store";
import { createRouter, parseBody, requireInstanceAdmin } from "../http/router.js";
import type { Db } from "../plugins/db.js";

/** Setting keys: lowercase letters, digits, dot, underscore, hyphen; 1 to 64 characters. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const putSchema = z.object({ value: z.unknown() }).strict();

const muteSchema = z.object({ hours: z.number().int().min(1).max(24 * 30) }).strict();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate the alert settings; null when the value is acceptable. */
async function alertSettingError(db: Db, key: string, value: unknown): Promise<string | null> {
  if (key === ALERT_SETTING.ENABLED) {
    return typeof value === "boolean" ? null : "alerts.enabled must be true or false.";
  }
  if (key === ALERT_SETTING.EMAIL) {
    if (typeof value !== "string") return "alerts.email must be an email address or \"\".";
    return value === "" || EMAIL_PATTERN.test(value.trim()) ? null : "alerts.email must be an email address or \"\".";
  }
  if (key === ALERT_SETTING.VIA_PRODUCT) {
    if (typeof value !== "string") return "alerts.via_product must be a product slug or \"\".";
    if (value === "") return null;
    const products = await storeFor(db).ops.listProducts();
    return products.some((p) => p.slug === value) ? null : `No product with slug "${value}".`;
  }
  if (key === ALERT_SETTING.MAIL_LOG || key === ALERT_SETTING.DIGEST_LAST) {
    return `${key} is managed by Claros.`;
  }
  return null;
}

/** Periodic jobs this runtime runs (partition maintenance exists on Postgres only). */
function periodicJobs(dialect: string): string[] {
  return Object.keys(TICK_INTERVAL_MINUTES).filter((q) => q !== QUEUE.PARTITION_MAINTENANCE || dialect === "pg");
}

const DAY = 24 * 60 * 60 * 1000;

export default function instanceRoutes() {
  const app = createRouter();
  const body = parseBody();

  app.get("/", body, requireInstanceAdmin, async (c) => {
    const db: Db = c.var.db;
    const [settings, users] = await Promise.all([
      storeFor(db).apiInstance.listSettings(),
      storeFor(db).apiInstance.listUsers(),
    ]);
    return c.json({
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        instance_role: u.instanceRole,
        home_product_id: u.homeTenantId,
        deactivated: u.deactivatedAt !== null,
        created_at: u.createdAt?.toISOString() ?? null,
        memberships: u.memberships.map((m) => ({ product_id: m.tenantId, slug: m.slug, role: m.role })),
      })),
    });
  });

  app.get("/health", body, requireInstanceAdmin, async (c) => {
    const db: Db = c.var.db;
    const store = storeFor(db);
    const now = new Date();
    const [open, resolved, events, beats, failedJobs, products, adminEmail, settings] = await Promise.all([
      store.ops.listAlerts({ status: "open", limit: 200 }),
      store.ops.listAlerts({ status: "resolved", limit: 20 }),
      store.ops.listEvents({ since: new Date(now.getTime() - 7 * DAY), limit: 100 }),
      store.ops.listSettingsByPrefix("tick."),
      store.ops.countEventsSince({ kinds: [OPS_KIND.DEAD_LETTER, OPS_KIND.JOB_FAILED], since: new Date(now.getTime() - DAY) }),
      store.ops.listProducts(),
      store.ops.firstInstanceAdminEmail(),
      store.ops.listSettingsByPrefix("alerts."),
    ]);
    const product = new Map(products.map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
    const setting = new Map(settings.map((s) => [s.key, s.value]));
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const enabledValue = setting.get(ALERT_SETTING.ENABLED);
    const beat = new Map(beats.map((b) => [b.key, b.value as { last_run_at?: unknown } | null]));

    return c.json({
      now: now.toISOString(),
      alerts: {
        open: open.map((a) => alertJson(a, product, now)),
        recently_resolved: resolved.map((a) => alertJson(a, product, now)),
      },
      events: events.map((e) => eventJson(e, product)),
      ticks: periodicJobs(store.dialect).map((queue) => {
        const raw = beat.get(`tick.${tickName(queue)}`)?.last_run_at;
        const lastRun = typeof raw === "string" ? raw : null;
        const interval = TICK_INTERVAL_MINUTES[queue]!;
        const late =
          lastRun !== null && now.getTime() - new Date(lastRun).getTime() > interval * TICK_LATE_FACTOR * 60_000;
        return { name: tickName(queue), last_run_at: lastRun, interval_minutes: interval, late };
      }),
      failed_jobs_24h: failedJobs,
      settings: {
        email: str(setting.get(ALERT_SETTING.EMAIL)),
        default_email: adminEmail,
        enabled: enabledValue !== false && enabledValue !== "false",
        via_product: str(setting.get(ALERT_SETTING.VIA_PRODUCT)),
      },
    });
  });

  app.post("/alerts/:fingerprint/resolve", body, requireInstanceAdmin, async (c) => {
    const db: Db = c.var.db;
    const fingerprint = c.req.param("fingerprint")!;
    const alert = await storeFor(db).ops.resolveAlert({ fingerprint });
    if (!alert) {
      const existing = await storeFor(db).ops.getAlert(fingerprint);
      if (!existing) return c.json({ error: "Alert not found." }, 404);
      return c.json({ alert: alertJson(existing, await productMap(db), new Date()) });
    }
    return c.json({ alert: alertJson(alert, await productMap(db), new Date()) });
  });

  app.post("/alerts/:fingerprint/mute", body, requireInstanceAdmin, async (c) => {
    const parsed = muteSchema.safeParse(c.var.body);
    if (!parsed.success) {
      return c.json({ error: "Body must be { \"hours\": <whole number from 1 to 720> }." }, 400);
    }
    const db: Db = c.var.db;
    const now = new Date();
    const alert = await storeFor(db).ops.muteAlert({
      fingerprint: c.req.param("fingerprint")!,
      until: new Date(now.getTime() + parsed.data.hours * 60 * 60 * 1000),
    });
    if (!alert) return c.json({ error: "Alert not found." }, 404);
    return c.json({ alert: alertJson(alert, await productMap(db), now) });
  });

  app.put("/settings/:key", body, requireInstanceAdmin, async (c) => {
    const key = c.req.param("key")!;
    if (!KEY_PATTERN.test(key)) {
      return c.json({ error: "Invalid setting key." }, 400);
    }
    const parsed = putSchema.safeParse(c.var.body);
    if (!parsed.success || parsed.data.value === undefined || parsed.data.value === null) {
      return c.json({ error: "Body must be { \"value\": <JSON, not null> }." }, 400);
    }
    const db: Db = c.var.db;
    const invalid = await alertSettingError(db, key, parsed.data.value);
    if (invalid) return c.json({ error: invalid }, 400);
    const value = key === ALERT_SETTING.EMAIL && typeof parsed.data.value === "string" ? parsed.data.value.trim() : parsed.data.value;
    const row = await storeFor(db).apiInstance.putSetting({ key, value, now: new Date() });
    return c.json({ key: row.key, value: row.value, updated_at: row.updatedAt?.toISOString() ?? null });
  });

  return app;
}

type ProductRef = { id: string; slug: string; name: string };

async function productMap(db: Db): Promise<Map<string, ProductRef>> {
  return new Map((await storeFor(db).ops.listProducts()).map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
}

function alertJson(a: OpsAlertRow, products: Map<string, ProductRef>, now: Date) {
  return {
    fingerprint: a.fingerprint,
    kind: a.kind,
    severity: a.severity,
    message: a.message,
    product: a.tenantId ? (products.get(a.tenantId) ?? { id: a.tenantId, slug: null, name: null }) : null,
    status: a.status,
    count: a.count,
    first_at: a.firstAt.toISOString(),
    last_at: a.lastAt.toISOString(),
    last_notified_at: a.lastNotifiedAt?.toISOString() ?? null,
    muted_until: a.mutedUntil && a.mutedUntil.getTime() > now.getTime() ? a.mutedUntil.toISOString() : null,
  };
}

function eventJson(e: OpsEventRow, products: Map<string, ProductRef>) {
  return {
    id: e.id,
    at: e.at.toISOString(),
    kind: e.kind,
    severity: e.severity,
    message: e.message,
    fingerprint: e.fingerprint,
    product: e.tenantId ? (products.get(e.tenantId) ?? { id: e.tenantId, slug: null, name: null }) : null,
    context: e.context ?? null,
  };
}
