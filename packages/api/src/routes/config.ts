/**
 * Config as code (G2).
 *
 *   GET /v1/config                 the product's configuration as a document
 *                                  (no secrets), a starting point for a file
 *   PUT /v1/config[?dry_run=1]     apply a document; dry_run returns the diff
 *
 * Owner session or an admin key with the `config` scope. The document is
 * validated by clarosConfigSchema (packages/core/src/config/schema.ts; JSON
 * Schema in docs/reference/claros.config.schema.json). Items are upserted by
 * slug (transports by name); nothing is deleted unless `prune: true`, which
 * deletes unlisted topics, templates and webhooks and archives unlisted flows,
 * for the kinds the document lists. The apply is one atomic unit and bumps
 * tenants.config_version; applying the same document again is an empty diff
 * and changes nothing. A concurrent apply that won first answers 409.
 *
 * Response: { dry_run, changes: [{kind, key, action, fields?}], config_version,
 * webhook_secrets? } where webhook_secrets holds the signing secrets
 * generated for new webhooks that had none in the document (shown once).
 */
import { randomUUID } from "node:crypto";
import { storeFor } from "@claros/store";
import {
  QUEUE,
  clarosConfigSchema,
  generateWebhookSecret,
  planConfig,
  type ConfigOp,
  type ConfigState,
} from "@claros/core";
import { decrypt, encrypt, parseEncryptionKey } from "@claros/adapters";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";

/** Config documents can carry many templates. */
const CONFIG_BODY_LIMIT = 4 * 1024 * 1024;

function encryptionKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    return parseEncryptionKey(raw);
  } catch {
    return null;
  }
}

export default function configRoutes() {
  const r = new RoleRouter({ limit: CONFIG_BODY_LIMIT });

  r.get("/", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const state = await storeFor(db).apiConfig.loadConfigState(c.var.tenant!.id);
    if (!state) return c.json({ error: "Product not found." }, 404);
    return c.json(exportConfig(state));
  });

  r.put("/", "owner", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const dryRun = ["1", "true"].includes(c.req.query("dry_run") ?? "");

    const parsed = clarosConfigSchema.safeParse(c.var.body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Validation failed",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    }
    const state = await storeFor(db).apiConfig.loadConfigState(tenantId);
    if (!state) return c.json({ error: "Product not found." }, 404);

    const key = encryptionKey();
    const plan = planConfig(parsed.data, state, {
      newId: () => randomUUID(),
      newSecret: () => generateWebhookSecret(),
      readSecret: (enc) => {
        if (!key) return null;
        try {
          return decrypt(enc, key);
        } catch {
          return null;
        }
      },
    });
    if (plan.errors.length > 0) {
      return c.json({ error: "The configuration cannot be applied.", errors: plan.errors, changes: plan.changes }, 400);
    }
    if (dryRun || plan.ops.length === 0) {
      return c.json({ dry_run: dryRun, changes: plan.changes, config_version: state.configVersion });
    }

    const needsKey =
      plan.ops.some((op) => op.op === "upsertEndpoint" && op.secret !== undefined) ||
      plan.ops.some((op) => op.op === "setSettings" && hasPlainSourceSecret(op.patch.data_sources));
    if (needsKey && !key) {
      return c.json({ error: "ENCRYPTION_KEY is not configured. Set it before storing webhook, analytics or data source secrets." }, 503);
    }
    const ops: ConfigOp[] = plan.ops.map((op) => {
      if (op.op === "upsertEndpoint" && op.secret !== undefined) return { ...op, secret: encrypt(op.secret, key!) };
      if (op.op === "setSettings" && hasPlainSourceSecret(op.patch.data_sources)) {
        // G11: data source secrets are stored encrypted (secret_enc), never in plain text.
        const sources: Record<string, Record<string, unknown>> = {};
        for (const [name, src] of Object.entries(op.patch.data_sources as Record<string, Record<string, unknown>>)) {
          const { secret, ...rest } = src;
          sources[name] = typeof secret === "string" ? { ...rest, secret_enc: encrypt(secret, key!) } : rest;
        }
        return { ...op, patch: { ...op.patch, data_sources: sources } };
      }
      return op;
    });
    const applied = await storeFor(db).apiConfig.applyConfigOps({
      tenantId,
      ops,
      expectedVersion: state.configVersion,
      now: new Date(),
    });
    if (!applied.ok) {
      return c.json({ error: "The configuration changed while this apply ran. Run it again." }, 409);
    }

    // G3: a changed list of date traits re-indexes the product's contact dates.
    const datePatch = ops.find((op): op is Extract<ConfigOp, { op: "setSettings" }> => op.op === "setSettings" && "date_traits" in op.patch);
    if (datePatch) {
      const traits = Array.isArray(datePatch.patch.date_traits) ? (datePatch.patch.date_traits as string[]) : [];
      await storeFor(db).apiConfig.reindexContactDates({ tenantId, properties: traits, now: new Date() });
    }

    // Prompt-defined flows that are new or changed get compiled.
    const enqueue = c.var.enqueue;
    if (enqueue) {
      for (const op of ops) {
        if (op.op === "upsertFlow" && op.compile) {
          await enqueue(QUEUE.COMPILE, { flow_id: op.id, tenant_id: tenantId }, { singletonKey: op.id }).catch(() => {});
        }
      }
    }

    return c.json({
      dry_run: false,
      changes: plan.changes,
      config_version: applied.configVersion,
      ...(Object.keys(plan.generatedSecrets).length > 0 ? { webhook_secrets: plan.generatedSecrets } : {}),
    });
  });

  return r.app;
}

function hasPlainSourceSecret(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).some((src) => !!src && typeof src === "object" && typeof (src as { secret?: unknown }).secret === "string");
}

/** The product's state as a config document (secrets left out). */
function exportConfig(state: ConfigState): Record<string, unknown> {
  const s = state.settings;
  const settings: Record<string, unknown> = {};
  for (const k of ["brand", "throttle", "postal_address", "links", "link_tracking", "brain", "data_sources", "date_traits", "activation_events"]) {
    if (s[k] === undefined || s[k] === null) continue;
    if (k === "data_sources" && typeof s[k] === "object") {
      settings[k] = Object.fromEntries(
        Object.entries(s[k] as Record<string, Record<string, unknown>>).map(([n, src]) => {
          const { secret_enc: _enc, ...rest } = src ?? {};
          return [n, rest];
        }),
      );
      continue;
    }
    settings[k] = s[k];
  }
  if (state.locale) settings.locale = state.locale;
  const analytics = state.endpoints.find((e) => e.kind === "analytics");
  if (analytics) {
    settings.analytics = {
      sink: (analytics.config?.sink as string | undefined) ?? "statsraven",
      endpoint: analytics.url,
      ...(typeof analytics.config?.site_key === "string" ? { site_key: analytics.config.site_key } : {}),
    };
  }
  const topicSlug = new Map(state.topics.map((t) => [t.id, t.slug]));
  const routing = (s.transport_routing ?? {}) as Record<string, string>;
  const nameOf = (id: string | undefined) => state.transports.find((t) => t.id === id)?.name ?? undefined;
  const route: Record<string, string> = {};
  if (nameOf(routing.transactional)) route.transactional = nameOf(routing.transactional)!;
  if (nameOf(routing.default)) route.default = nameOf(routing.default)!;
  return {
    version: 1,
    settings,
    topics: state.topics.map((t) => ({
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      ...(t.description ? { description: t.description } : {}),
      default_subscribed: t.defaultSubscribed,
    })),
    templates: state.templates
      .filter((t) => t.isActive !== false)
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        body_html: t.bodyHtml,
        ...(t.bodyText ? { body_text: t.bodyText } : {}),
        ...(t.category ? { category: t.category } : {}),
      })),
    ...(Object.keys(route).length > 0 ? { transports: { routing: route } } : {}),
    flows: state.flows
      .filter((f) => f.slug !== null && f.status !== "archived")
      .map((f) => {
        const plan = (f.compiledPlan ?? {}) as { steps?: unknown[]; exit_conditions?: unknown[] };
        return {
          slug: f.slug,
          name: f.name,
          ...(f.description ? { description: f.description } : {}),
          status: f.status,
          trigger: { type: f.triggerType, ...((f.triggerConfig as Record<string, unknown>) ?? {}) },
          ...(f.promptSource ? { prompt: f.promptSource } : { steps: plan.steps ?? f.steps }),
          ...(plan.exit_conditions && !f.promptSource ? { exit_conditions: plan.exit_conditions } : {}),
          content_mode: f.contentMode,
          approval_mode: f.approvalMode,
          flow_class: f.flowClass,
          priority: f.priority ?? 0,
          reentry: { policy: f.reentryPolicy, cooldown_days: f.reentryCooldownDays ?? 30 },
          topic: f.topicId ? (topicSlug.get(f.topicId) ?? null) : null,
        };
      }),
    webhooks: state.endpoints
      .filter((e) => e.kind === "webhook")
      .map((e) => ({ slug: e.slug, url: e.url, events: e.events, enabled: e.enabled })),
  };
}
