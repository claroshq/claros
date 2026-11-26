/**
 * GET /v1/capabilities (item 11): what this instance supports, so clients
 * (the CLI, a product's preflight, an agent) can check before relying on a
 * feature.
 *
 *   { backend: "postgres" | "d1", runtime: "node" | "workers",
 *     kb: { semantic }, events: { partitioned },
 *     transports: ["resend", "smtp", "cloudflare"], features: [...] }
 *
 * Callers: any dashboard session (member), a product admin key of any
 * scope, or an instance key with instance:read.
 *
 * kb.semantic: the knowledge base supports similarity search over
 * embeddings, on Postgres with pgvector, on D1 with cosine similarity
 * computed over the stored vectors (DECISIONS.md, "Embedding provider"). It is used once the
 * product has an embedding provider; without one, entries are found by word
 * matching on both backends. Postgres keeps the monthly-partitioned events
 * table; D1 a plain events table (DECISIONS.md D5). Every transport kind exists on both runtimes:
 * on Node, Cloudflare Email Service goes through the REST API and SMTP
 * through nodemailer; on Workers, through the send_email binding (or the
 * REST API) and worker-mailer.
 */
import type { MiddlewareHandler } from "hono";
import { storeFor } from "@claros/store";
import { TRANSPORT_KINDS } from "@claros/core";
import { createRouter, parseBody } from "../http/router.js";
import type { AppEnv } from "../http/env.js";
import { bearerAdminKey, bearerInstanceKey, checkInstanceKey } from "../http/admin-auth.js";
import { hashApiKey } from "../http/ingest-auth.js";
import type { Db } from "../plugins/db.js";

/**
 * Stable feature ids. A feature is listed once it is in the running code;
 * ids are never renamed (new ids are added instead).
 */
export const FEATURES = [
  "multi_product",
  "topics",
  "transport_routing",
  "admin_keys",
  "instance_keys",
  "config_as_code",
  "suppressions_api",
  "approval_actions",
  "trait_conditions",
  "history_conditions",
  "condition_combinators",
  "signed_webhooks",
  "analytics_sink",
  "utm_tagging",
  "date_triggers",
  "context_sources",
  "kb_select",
  "kb_import",
  "link_allowlist",
  "text_rules",
  "ai_opening_line",
  "choose_step",
  "history_import",
  "scheduled_flow_class",
  "mirror_only_topics",
  "llm_daily_token_budget",
  "approvals_daily_digest",
  "flow_pause_resume_api",
  "people_erase",
  "lifecycle_segments",
  "event_trigger_lists",
  "trigger_where",
  "manual_enrollment",
  "step_persona",
  "event_template_variables",
  "archived_products",
  "value_gate_settings",
  "webhook_batch_interval",
  "engagement_events",
  "brand_logo_upload",
  "email_templates",
  "event_history_import",
] as const;

export type Runtime = "node" | "workers";

/** Any session, any product admin key, or an instance key with instance:read. */
const anyCaller: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.tenant) return next();
  const db = c.var.db;
  const admin = bearerAdminKey(c);
  if (admin && db) {
    const row = await storeFor(db).apiAdminAuth.findActiveAdminKeyByHash(hashApiKey(admin));
    if (!row) return c.json({ error: "Invalid or revoked API key." }, 401);
    return next();
  }
  const instance = bearerInstanceKey(c);
  if (instance && db) {
    const check = await checkInstanceKey(c, instance, ["instance:read"]);
    if (!check.ok) return check.response;
    return next();
  }
  return c.json({ error: "Authentication required." }, 401);
};

export default function capabilitiesRoutes(opts: { runtime?: Runtime } = {}) {
  const app = createRouter();
  app.get("/", parseBody(), anyCaller, (c) => {
    const db: Db = c.var.db;
    const postgres = storeFor(db).dialect === "pg";
    const runtime: Runtime = opts.runtime ?? (postgres ? "node" : "workers");
    return c.json({
      backend: postgres ? "postgres" : "d1",
      runtime,
      kb: { semantic: true },
      events: { partitioned: postgres },
      transports: [...TRANSPORT_KINDS],
      features: [...FEATURES],
    });
  });
  return app;
}
