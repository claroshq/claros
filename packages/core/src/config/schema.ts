/**
 * Config as code (G2): the document `PUT /v1/config` and `claros apply`
 * take. One JSON document per product; every item is keyed by its slug
 * (transports by name). docs/reference/claros.config.schema.json is
 * generated from this schema (scripts/gen-config-schema.mjs); see
 * docs/guide/CONFIG.md.
 */
import { z } from "zod";
import { compiledStepSchema, planExitConditionSchema } from "../flow/compiled-plan.js";
import { audienceConditionOrListSchema } from "../conditions.js";
import { linkTrackingSchema } from "../link-tracking.js";
import { datePropertyTriggerSchema, dateScheduleTriggerSchema } from "../dates.js";
import { TOPIC_KINDS } from "../topics-transports.js";
import { RETENTION_TENURE_BUCKETS, RETENTION_RECENCY_BUCKETS } from "../lifecycle/retention-grid.js";
import { LIFECYCLE_STATES } from "../lifecycle/states.js";
import { ENGAGEMENT_DEPTHS } from "../lifecycle/engagement-depth.js";
import { WEBHOOK_EVENTS, ANALYTICS_SINKS } from "../webhooks.js";

/** Slugs of flows, templates, topics and webhooks: 1-63 of [a-z0-9_-]. */
export const CONFIG_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const slug = z.string().regex(CONFIG_SLUG, { message: "slug: 1-63 characters of a-z, 0-9, _ and -, starting with a letter or digit" });
const httpUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), { message: "must be an http(s) URL" });

/**
 * A flow step in a config document: the compiled step shape, strict. An
 * unknown key is an error (it would otherwise be dropped silently); stored
 * plans and LLM-compiled plans keep the lenient compiledStepSchema.
 */
export const configStepSchema = compiledStepSchema.strict();

export const configTopicSchema = z
  .object({
    slug,
    name: z.string().min(1).max(120),
    kind: z.enum(TOPIC_KINDS),
    description: z.string().max(500).nullable().optional(),
    default_subscribed: z.boolean().optional(),
    /** P5b: the topic only mirrors a consent kept elsewhere; no flow may send on it. */
    mirror_only: z.boolean().optional(),
  })
  .strict();

export const configTemplateSchema = z
  .object({
    slug,
    name: z.string().min(1).max(200),
    subject: z.string().min(1).max(300),
    body_html: z.string().min(1).max(200_000),
    body_text: z.string().max(200_000).nullable().optional(),
    category: z.string().max(60).nullable().optional(),
  })
  .strict();

/** Trigger keys each type reads; others are reported as warnings by planConfig. */
export const TRIGGER_KEYS: Readonly<Record<string, readonly string[]>> = {
  event: ["event", "where"],
  lifecycle_transition: ["from", "to", "where"],
  segment: ["tenure_bucket", "recency_bucket", "lifecycle_states", "engagement_depths", "where"],
  manual: ["where"],
  date_property: ["property", "offset", "send_at_local", "where"],
  date_schedule: ["anchor", "offsets", "repeat", "max_sends", "send_at_local", "where"],
};

export const configTriggerSchema = z
  .object({
    type: z.enum(["event", "lifecycle_transition", "segment", "manual", "date_property", "date_schedule"]),
    /** event: the event name, or a list of names (any of them triggers). */
    event: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(20)]).optional(),
    /**
     * Every trigger type: audience conditions that must hold for the contact
     * (trait, history, first_contact, lifecycle_state, combinators; a list
     * must all hold).
     */
    where: audienceConditionOrListSchema.optional(),
    /** lifecycle_transition: from (optional) and to. */
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    /** segment: one retention-grid cell ... */
    tenure_bucket: z.enum(RETENTION_TENURE_BUCKETS).optional(),
    recency_bucket: z.enum(RETENTION_RECENCY_BUCKETS).optional(),
    /** ... or contacts in any of these lifecycle states (and engagement depths). */
    lifecycle_states: z.array(z.enum(LIFECYCLE_STATES)).min(1).max(LIFECYCLE_STATES.length).optional(),
    engagement_depths: z.array(z.enum(ENGAGEMENT_DEPTHS)).min(1).max(ENGAGEMENT_DEPTHS.length).optional(),
    /** date_property (G3): the date trait and the signed offset from it ("-3d"). */
    property: z.string().min(1).max(64).optional(),
    offset: z.string().optional(),
    /** date_schedule (G3): the anchor date trait, offsets, repeat interval and cap. */
    anchor: z.string().min(1).max(64).optional(),
    offsets: z.array(z.string()).optional(),
    repeat: z.string().optional(),
    max_sends: z.number().int().optional(),
    /** Date triggers: send at this local time ("09:00") on the due day. */
    send_at_local: z.string().optional(),
  })
  .passthrough()
  .superRefine((t, ctx) => {
    if (t.type === "event" && !t.event) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event triggers need 'event'" });
    if (t.type === "lifecycle_transition" && !t.to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lifecycle_transition triggers need 'to'" });
    if (t.type === "segment") {
      const cell = t.tenure_bucket !== undefined || t.recency_bucket !== undefined;
      const states = t.lifecycle_states !== undefined || t.engagement_depths !== undefined;
      if (cell && states) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "segment triggers take a grid cell (tenure_bucket, recency_bucket) or lifecycle_states / engagement_depths, not both" });
      } else if (cell && (!t.tenure_bucket || !t.recency_bucket)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a grid-cell segment trigger needs both tenure_bucket and recency_bucket" });
      } else if (!cell && !states) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "segment triggers need a grid cell (tenure_bucket, recency_bucket) or lifecycle_states / engagement_depths" });
      }
    }
    if (t.type === "date_property" || t.type === "date_schedule") {
      const schema = t.type === "date_property" ? datePropertyTriggerSchema : dateScheduleTriggerSchema;
      const r = schema.safeParse(t);
      if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  });

export const configFlowSchema = z
  .object({
    slug,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    /** Omitted: an existing flow keeps its status; a new one is active. */
    status: z.enum(["active", "paused", "draft"]).optional(),
    trigger: configTriggerSchema,
    /** Explicit steps (compiled plan steps). Either steps or prompt. */
    steps: z.array(configStepSchema).min(1).max(50).optional(),
    exit_conditions: z.array(planExitConditionSchema).max(20).optional(),
    /** A natural-language flow, compiled by the LLM after apply. */
    prompt: z.string().min(1).max(20_000).optional(),
    content_mode: z.enum(["ai_drafted", "fixed_content"]).optional(),
    approval_mode: z.enum(["require", "auto"]).optional(),
    /**
     * critical: concurrent, bypasses frequency caps; nurture: one active per
     * contact; scheduled: concurrent like critical, but throttled and
     * windowed like nurture.
     */
    flow_class: z.enum(["critical", "nurture", "scheduled"]).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    reentry: z
      .object({
        policy: z.enum(["once", "cooldown", "every_time"]),
        cooldown_days: z.number().int().min(0).max(3650).optional(),
      })
      .strict()
      .optional(),
    /** Topic slug, or null for no topic. */
    topic: slug.nullable().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (!f.steps && !f.prompt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a flow needs 'steps' or 'prompt'" });
    if (f.steps && f.prompt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a flow takes 'steps' or 'prompt', not both" });
    if (f.steps) {
      const orders = f.steps.map((s) => s.order);
      if (new Set(orders).size !== orders.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "step orders must be unique" });
      for (const s of f.steps) {
        if (s.type === "choose" && (!s.candidates || s.candidates.length === 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${s.order}: a choose step needs candidates` });
        }
        if (s.type !== "choose" && (s.candidates !== undefined || s.allow_none !== undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${s.order}: candidates and allow_none belong to choose steps (type: "choose")` });
        }
        if (s.candidates) {
          const types = s.candidates.map((c) => c.action_type);
          if (new Set(types).size !== types.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${s.order}: candidate action types must be unique` });
        }
      }
    }
  });

export const configWebhookSchema = z
  .object({
    slug,
    url: httpUrl,
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
    enabled: z.boolean().optional(),
    /** Signing secret (whsec_...). Omitted: generated on create (returned once), kept on update. */
    secret: z.string().min(16).max(200).optional(),
    /** P5b: window of the batched message.pending_approval event, in minutes (default 15). */
    batch_interval_minutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();

export const configAnalyticsSchema = z
  .object({
    sink: z.enum(ANALYTICS_SINKS),
    /** statsraven: the StatsRaven base URL (events go to /ingest); webhook: the receiver URL. */
    endpoint: httpUrl,
    site_key: z.string().max(200).optional(),
    /** statsraven: the ingest token; webhook: the signing secret. Omitted on update: kept. */
    secret: z.string().min(8).max(500).optional(),
  })
  .strict();

/**
 * G11: a context data source. The request is signed (Standard Webhooks)
 * with `secret` (write-only: stored encrypted, never returned) or the
 * environment variable / Worker secret named by `secret_ref`
 * (`secret_env` is accepted as an alias).
 */
export const configDataSourceSchema = z
  .object({
    url: httpUrl.refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(u), {
      message: "must be an absolute https URL (http only for localhost)",
    }),
    secret: z.string().min(16).max(500).optional(),
    secret_ref: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/, { message: "secret_ref names an environment variable (A-Z, 0-9, _)" }).optional(),
    secret_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/, { message: "secret_env names an environment variable (A-Z, 0-9, _)" }).optional(),
    timeout_ms: z.number().int().min(100).max(30_000).optional(),
    /** The signature scheme; only Standard Webhooks exists. */
    signature: z.literal("standard-webhooks").optional(),
    /** Modes the source accepts; when listed, steps may only use these. */
    modes: z.array(z.string().min(1).max(64)).max(20).optional(),
    /** Free-form description of the response, for people reading the config. */
    response_shape: z.string().max(2000).optional(),
  })
  .strict();

export const textRuleSchema = z.union([
  z.string().min(1).max(500),
  z.object({ find: z.string().min(1).max(500), replace: z.string().max(500) }).strict(),
  z.object({ forbid: z.string().min(1).max(500) }).strict(),
]);

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** P5b: lifecycle thresholds (the keys of LifecycleConfig). */
export const configLifecycleSchema = z
  .object({
    activation_events: z.array(z.string().min(1).max(200)).max(50).optional(),
    /** Track events that count as activity; unset or empty = every track and identify. */
    engagement_events: z.array(z.string().min(1).max(200)).max(50).optional(),
    activation_window_days: z.number().int().min(1).max(365).optional(),
    natural_frequency_days: z.number().int().min(1).max(365).optional(),
    at_risk_missed_intervals: z.number().int().min(1).max(52).optional(),
    dormant_days: z.number().int().min(1).max(3650).optional(),
    churned_days: z.number().int().min(1).max(3650).optional(),
    engagement_depth_window_days: z.number().int().min(1).max(365).optional(),
    power_user_percentile: z.number().gt(0).lt(1).optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.dormant_days !== undefined && l.churned_days !== undefined && l.churned_days <= l.dormant_days) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "churned_days must be greater than dormant_days" });
    }
  });

export const configSettingsSchema = z
  .object({
    brand: z.record(z.unknown()).optional(),
    throttle: z.record(z.unknown()).optional(),
    postal_address: z.string().max(500).optional(),
    links: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), httpUrl).optional(),
    link_tracking: linkTrackingSchema.nullable().optional(),
    locale: z.string().regex(LOCALE).nullable().optional(),
    brain: z
      .object({
        guidelines: z.string().max(20_000).optional(),
        /**
         * G19: a string is a writing rule given to the drafting model; an
         * object is applied to every draft after drafting: {find, replace}
         * replaces text (find is a literal string, or /pattern/flags), {forbid}
         * fails the draft when the text appears.
         */
        text_rules: z.array(textRuleSchema).max(100).optional(),
        /**
         * P5b: the value gate. enabled false skips it (drafts go straight to
         * approval); threshold (1-10) asks the gate for a score and holds
         * back drafts that score below it.
         */
        assess: z
          .object({
            enabled: z.boolean().optional(),
            threshold: z.number().int().min(1).max(10).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** P5b: lifecycle thresholds (tenants.settings.lifecycle). */
    lifecycle: configLifecycleSchema.optional(),
    /** P5b: LLM tokens a product may use per UTC day; over it, drafts wait (reason llm_budget). */
    llm_daily_token_budget: z.number().int().min(1000).max(1_000_000_000).nullable().optional(),
    /** P5b: approvals. daily_digest mails the product's owners the waiting approvals at 08:00 product time. */
    approvals: z
      .object({ daily_digest: z.boolean().optional() })
      .strict()
      .optional(),
    data_sources: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), configDataSourceSchema).optional(),
    date_traits: z.array(z.string().min(1).max(64)).max(50).optional(),
    activation_events: z.array(z.string().min(1).max(200)).max(50).optional(),
    analytics: configAnalyticsSchema.nullable().optional(),
  })
  .strict();

export const clarosConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).optional(),
    /** Delete (archive, for flows) items of the listed kinds that the document does not list. Default false. */
    prune: z.boolean().optional(),
    settings: configSettingsSchema.optional(),
    topics: z.array(configTopicSchema).max(200).optional(),
    templates: z.array(configTemplateSchema).max(500).optional(),
    transports: z
      .object({
        routing: z
          .object({
            /** Transport name (transport_configs.name) for transactional-topic mail. */
            transactional: z.string().min(1).max(120).nullable().optional(),
            /** Transport name for everything else. */
            default: z.string().min(1).max(120).nullable().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    flows: z.array(configFlowSchema).max(200).optional(),
    webhooks: z.array(configWebhookSchema).max(20).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [kind, items] of [
      ["topics", c.topics],
      ["templates", c.templates],
      ["flows", c.flows],
      ["webhooks", c.webhooks],
    ] as const) {
      const seen = new Set<string>();
      for (const item of items ?? []) {
        if (seen.has(item.slug)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [kind], message: `duplicate slug '${item.slug}'` });
        seen.add(item.slug);
      }
    }
  });

export type ClarosConfig = z.infer<typeof clarosConfigSchema>;
export type ConfigFlow = z.infer<typeof configFlowSchema>;
export type ConfigTopic = z.infer<typeof configTopicSchema>;
export type ConfigTemplate = z.infer<typeof configTemplateSchema>;
export type ConfigWebhook = z.infer<typeof configWebhookSchema>;
export type ConfigAnalytics = z.infer<typeof configAnalyticsSchema>;
export type ConfigSettings = z.infer<typeof configSettingsSchema>;
