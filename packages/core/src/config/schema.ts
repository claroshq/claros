/**
 * Config as code (G2): the document `PUT /v1/config` and `claros apply`
 * take. One JSON document per product; every item is keyed by its slug
 * (transports by name). docs/reference/claros.config.schema.json is
 * generated from this schema (scripts/gen-config-schema.mjs); see
 * docs/guide/CONFIG.md.
 */
import { z } from "zod";
import { compiledStepSchema, planExitConditionSchema } from "../flow/compiled-plan.js";
import { contactConditionSchema } from "../conditions.js";
import { linkTrackingSchema } from "../link-tracking.js";
import { TOPIC_KINDS } from "../topics-transports.js";
import { WEBHOOK_EVENTS, ANALYTICS_SINKS } from "../webhooks.js";

/** Slugs of flows, templates, topics and webhooks: 1-63 of [a-z0-9_-]. */
export const CONFIG_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const slug = z.string().regex(CONFIG_SLUG, { message: "slug: 1-63 characters of a-z, 0-9, _ and -, starting with a letter or digit" });
const httpUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), { message: "must be an http(s) URL" });

export const configTopicSchema = z
  .object({
    slug,
    name: z.string().min(1).max(120),
    kind: z.enum(TOPIC_KINDS),
    description: z.string().max(500).nullable().optional(),
    default_subscribed: z.boolean().optional(),
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

export const configTriggerSchema = z
  .object({
    type: z.enum(["event", "lifecycle_transition", "segment", "manual"]),
    /** event: the event name. */
    event: z.string().min(1).max(200).optional(),
    /** event: conditions that must hold for the contact (trait, history, first_contact). */
    where: z.array(contactConditionSchema).optional(),
    /** lifecycle_transition: from (optional) and to. */
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((t, ctx) => {
    if (t.type === "event" && !t.event) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event triggers need 'event'" });
    if (t.type === "lifecycle_transition" && !t.to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lifecycle_transition triggers need 'to'" });
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
    steps: z.array(compiledStepSchema).min(1).max(50).optional(),
    exit_conditions: z.array(planExitConditionSchema).max(20).optional(),
    /** A natural-language flow, compiled by the LLM after apply. */
    prompt: z.string().min(1).max(20_000).optional(),
    content_mode: z.enum(["ai_drafted", "fixed_content"]).optional(),
    approval_mode: z.enum(["require", "auto"]).optional(),
    flow_class: z.enum(["critical", "nurture"]).optional(),
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

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

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
        text_rules: z.array(z.string().max(500)).max(100).optional(),
      })
      .strict()
      .optional(),
    data_sources: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.record(z.unknown())).optional(),
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
