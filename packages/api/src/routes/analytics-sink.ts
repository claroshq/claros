/**
 * The product's analytics sink (G30), the `settings.analytics` part of the
 * config document, read and changed on its own: the dashboard webhooks page
 * and the management API.
 *
 *   GET    /v1/analytics-sink   the sink (secret never returned) and whether the caller may change it
 *   PUT    /v1/analytics-sink   set it: { sink, endpoint, site_key?, secret? }; secret omitted keeps the stored one
 *   DELETE /v1/analytics-sink   remove it (its undelivered events are dropped)
 *
 * GET: any member, or an admin key with the `config` scope. PUT and DELETE:
 * owner session or an admin key with the `config` scope. The body is
 * validated with the config document's schema for settings.analytics, and
 * the write goes through the config apply (applyConfigDocument), so it
 * stores exactly what a document with the same settings.analytics stores:
 * the secret encrypted with ENCRYPTION_KEY (503 without it) and a bump of
 * the product's config_version. A config document that sets
 * settings.analytics replaces this on its next apply.
 */
import { storeFor } from "@claros/store";
import type { WebhookEndpointRow } from "@claros/store";
import { ANALYTICS_ENDPOINT_SLUG, ANALYTICS_SINKS, configAnalyticsSchema } from "@claros/core";
import type { Db } from "../plugins/db.js";
import type { AppContext } from "../http/env.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";
import { applyConfigDocument } from "./config.js";

function serialize(e: WebhookEndpointRow | null) {
  if (!e) return null;
  return {
    sink: e.config?.sink === "webhook" ? "webhook" : "statsraven",
    endpoint: e.url,
    ...(typeof e.config?.site_key === "string" ? { site_key: e.config.site_key } : {}),
    has_secret: e.hasSecret,
    enabled: e.enabled,
    updated_at: e.updatedAt?.toISOString() ?? null,
  };
}

async function current(c: AppContext): Promise<WebhookEndpointRow | null> {
  const db: Db = c.var.db;
  const row = await storeFor(db).apiWebhooks.findEndpoint({ tenantId: c.var.tenant!.id, slug: ANALYTICS_ENDPOINT_SLUG });
  return row && row.kind === "analytics" ? row : null;
}

async function view(c: AppContext) {
  return {
    analytics_sink: serialize(await current(c)),
    sinks: ANALYTICS_SINKS,
    editable: c.var.tenant!.userRole === "owner",
  };
}

export default function analyticsSinkRoutes() {
  const r = new RoleRouter();

  r.get("/", "member", allowAdminKey("config"), async (c) => c.json(await view(c)));

  r.put("/", "owner", allowAdminKey("config"), async (c) => {
    const parsed = configAnalyticsSchema.safeParse(c.var.body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    const result = await applyConfigDocument({
      db: c.var.db,
      tenantId: c.var.tenant!.id,
      config: { version: 1, settings: { analytics: parsed.data } },
      dryRun: false,
      enqueue: c.var.enqueue,
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ ...(await view(c)), changes: result.changes, config_version: result.configVersion });
  });

  r.delete("/", "owner", allowAdminKey("config"), async (c) => {
    if (!(await current(c))) return c.json({ error: "No analytics sink is set." }, 404);
    const result = await applyConfigDocument({
      db: c.var.db,
      tenantId: c.var.tenant!.id,
      config: { version: 1, settings: { analytics: null } },
      dryRun: false,
      enqueue: c.var.enqueue,
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ success: true, config_version: result.configVersion });
  });

  return r.app;
}
