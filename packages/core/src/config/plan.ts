/**
 * Config as code (G2): compare a config document with the product's current
 * state and produce the changes (for ?dry_run=1 and the apply response) and
 * the row-level operations the store applies in one atomic unit.
 *
 * Pure apart from id and secret generation, which the caller injects.
 * Idempotent by construction: an item whose normalized fields equal the
 * current row produces no change, so applying a document twice yields an
 * empty diff the second time.
 */
import { builtinLayout, isCustomLayoutRef } from "../layout-templates.js";
import { TRIGGER_KEYS, type ClarosConfig, type ConfigFlow } from "./schema.js";
import { ANALYTICS_ENDPOINT_SLUG, ANALYTICS_SOURCE_EVENTS } from "../webhooks.js";

export interface StateTopic {
  id: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  defaultSubscribed: boolean;
  /** P5b; absent on older state readers (false). */
  mirrorOnly?: boolean;
}
export interface StateTemplate {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  category: string | null;
  isActive: boolean | null;
}
export interface StateFlow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  status: string | null;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown;
  compiledPlan: unknown;
  promptSource: string | null;
  contentMode: string | null;
  approvalMode: string | null;
  flowClass: string;
  priority: number | null;
  reentryPolicy: string;
  reentryCooldownDays: number | null;
  topicId: string | null;
  /** Email template ref (built-in key or custom id), null = the product's. */
  emailTemplate?: string | null;
}
export interface StateTransport {
  id: string;
  name: string | null;
  kind: string;
  isActive: boolean;
}
export interface StateEndpoint {
  id: string;
  slug: string;
  kind: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** Encrypted secret, or null. */
  secret: string | null;
  config: Record<string, unknown> | null;
}
export interface ConfigState {
  settings: Record<string, unknown>;
  locale: string | null;
  configVersion: number;
  topics: StateTopic[];
  templates: StateTemplate[];
  flows: StateFlow[];
  transports: StateTransport[];
  endpoints: StateEndpoint[];
  /** Whether the product has an active LLM configuration (choose steps need one). Absent: not checked. */
  hasLlm?: boolean;
}

export type ConfigChangeKind = "setting" | "routing" | "topic" | "template" | "flow" | "webhook" | "analytics";
export interface ConfigChange {
  kind: ConfigChangeKind;
  key: string;
  action: "create" | "update" | "delete" | "archive";
  fields?: string[];
}

export interface FlowValues {
  slug: string;
  name: string;
  description: string | null;
  status: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  steps: unknown[];
  compiledPlan: Record<string, unknown> | null;
  compileStatus: string | null;
  promptSource: string | null;
  contentMode: string;
  approvalMode: string;
  flowClass: string;
  priority: number;
  reentryPolicy: string;
  reentryCooldownDays: number;
  topicId: string | null;
  emailTemplate: string | null;
}

export type ConfigOp =
  | { op: "upsertTopic"; id: string; create: boolean; values: { slug: string; name: string; kind: string; description: string | null; defaultSubscribed: boolean; mirrorOnly: boolean } }
  | { op: "deleteTopic"; id: string }
  | { op: "upsertTemplate"; id: string; create: boolean; values: { slug: string; name: string; subject: string; bodyHtml: string; bodyText: string | null; category: string | null } }
  | { op: "deleteTemplate"; id: string }
  | { op: "upsertFlow"; id: string; create: boolean; values: FlowValues; compile: boolean }
  | { op: "archiveFlow"; id: string }
  | {
      op: "upsertEndpoint";
      id: string;
      create: boolean;
      values: { slug: string; kind: string; url: string; events: string[]; enabled: boolean; config: Record<string, unknown> | null };
      /** Plain secret to encrypt and store; undefined keeps the current one. */
      secret?: string;
    }
  | { op: "deleteEndpoint"; id: string }
  | { op: "setSettings"; patch: Record<string, unknown> }
  | { op: "setLocale"; locale: string | null };

export interface ConfigPlan {
  changes: ConfigChange[];
  ops: ConfigOp[];
  errors: string[];
  /** P5b: things that apply but probably do not do what the document means (unknown trigger keys, ...). */
  warnings: string[];
  /** Secrets generated for new webhooks (slug -> secret), returned once by apply. */
  generatedSecrets: Record<string, string>;
}

export interface PlanDeps {
  newId(): string;
  newSecret(): string;
  /** Decrypt a stored secret (to compare with the document); null when it cannot be read. */
  readSecret(encrypted: string): string | null;
}

/** Deep equality with object keys in any order (jsonb does not keep key order). */
export function sameJson(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** Drop undefined values (so a normalized object compares like its stored JSON). */
function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function diffFields(current: Record<string, unknown>, next: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => !sameJson(current[k], next[k]));
}

export const SETTINGS_KEYS = [
  "brand",
  "throttle",
  "postal_address",
  "links",
  "link_tracking",
  "brain",
  "data_sources",
  "date_traits",
  "activation_events",
  "lifecycle",
  "llm_daily_token_budget",
  "approvals",
] as const;

export function planConfig(config: ClarosConfig, state: ConfigState, deps: PlanDeps): ConfigPlan {
  const changes: ConfigChange[] = [];
  const ops: ConfigOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const generatedSecrets: Record<string, string> = {};
  const prune = config.prune === true;

  // --- Settings -------------------------------------------------------------
  const patch: Record<string, unknown> = {};
  const s = config.settings ?? {};
  for (const key of SETTINGS_KEYS) {
    const want = (s as Record<string, unknown>)[key];
    if (want === undefined) continue;
    const have = state.settings[key];
    if (want === null) {
      if (have !== undefined && have !== null) {
        patch[key] = null;
        changes.push({ kind: "setting", key, action: "delete" });
      }
      continue;
    }
    let normalized = key === "brain" || key === "lifecycle" || key === "approvals" ? clean(want as Record<string, unknown>) : want;
    if (key === "data_sources") {
      // Secrets are write-only: the stored form keeps `secret_enc`. A source
      // without `secret` keeps its stored one; a changed secret is passed on
      // as `secret` for the caller to encrypt.
      const haveSources = (have && typeof have === "object" ? have : {}) as Record<string, Record<string, unknown>>;
      const next: Record<string, Record<string, unknown>> = {};
      let secretChanged = false;
      for (const [name, src] of Object.entries(want as Record<string, Record<string, unknown>>)) {
        const { secret, ...rest } = src;
        const stored = haveSources[name]?.secret_enc;
        if (typeof secret === "string") {
          const same = typeof stored === "string" && deps.readSecret(stored) === secret;
          if (same) next[name] = { ...rest, secret_enc: stored };
          else {
            next[name] = { ...rest, secret };
            secretChanged = true;
          }
        } else {
          next[name] = typeof stored === "string" ? { ...rest, secret_enc: stored } : rest;
        }
      }
      normalized = next;
      if (secretChanged || !sameJson(have, next)) {
        patch[key] = next;
        changes.push({ kind: "setting", key, action: have === undefined ? "create" : "update" });
      }
      continue;
    }
    if (!sameJson(have, normalized)) {
      patch[key] = normalized;
      changes.push({ kind: "setting", key, action: have === undefined ? "create" : "update" });
    }
  }
  if (s.locale !== undefined && (s.locale ?? null) !== state.locale) {
    ops.push({ op: "setLocale", locale: s.locale ?? null });
    changes.push({ kind: "setting", key: "locale", action: state.locale === null ? "create" : s.locale === null ? "delete" : "update" });
  }

  // --- Transport routing (by name) -------------------------------------------
  if (config.transports?.routing) {
    const want = config.transports.routing;
    const current = (state.settings.transport_routing ?? {}) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const route of ["transactional", "default"] as const) {
      const name = want[route];
      if (name === undefined) {
        if (typeof current[route] === "string") next[route] = current[route] as string;
        continue;
      }
      if (name === null) continue;
      const t = state.transports.filter((x) => x.isActive && x.name === name);
      if (t.length === 0) {
        errors.push(`transports.routing.${route}: no active transport named '${name}'`);
        continue;
      }
      if (t.length > 1) {
        errors.push(`transports.routing.${route}: more than one active transport is named '${name}'`);
        continue;
      }
      if (route === "default" && t[0]!.kind === "cloudflare") {
        errors.push(
          `transports.routing.default: '${name}' is a cloudflare transport; Cloudflare Email Service sends transactional mail only. Route lifecycle and marketing mail to a resend or smtp transport.`,
        );
        continue;
      }
      next[route] = t[0]!.id;
    }
    if (!sameJson(current, next)) {
      patch.transport_routing = Object.keys(next).length > 0 ? next : null;
      changes.push({ kind: "routing", key: "transport_routing", action: Object.keys(current).length === 0 ? "create" : "update" });
    }
  }

  // --- Topics ----------------------------------------------------------------
  const topicIdBySlug = new Map(state.topics.map((t) => [t.slug, t.id]));
  const listedTopics = new Set<string>();
  for (const t of config.topics ?? []) {
    listedTopics.add(t.slug);
    const cur = state.topics.find((x) => x.slug === t.slug);
    const values = {
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      description: t.description ?? null,
      defaultSubscribed: t.default_subscribed ?? true,
      mirrorOnly: t.mirror_only ?? false,
    };
    if (!cur) {
      const id = deps.newId();
      topicIdBySlug.set(t.slug, id);
      ops.push({ op: "upsertTopic", id, create: true, values });
      changes.push({ kind: "topic", key: t.slug, action: "create" });
      continue;
    }
    const fields = diffFields({ ...cur, mirrorOnly: cur.mirrorOnly ?? false } as unknown as Record<string, unknown>, values, ["name", "kind", "description", "defaultSubscribed", "mirrorOnly"]);
    if (fields.length > 0) {
      ops.push({ op: "upsertTopic", id: cur.id, create: false, values });
      changes.push({ kind: "topic", key: t.slug, action: "update", fields });
    }
  }

  // --- Templates -------------------------------------------------------------
  const templateSlugs = new Set(state.templates.map((t) => t.slug));
  const listedTemplates = new Set<string>();
  for (const t of config.templates ?? []) {
    listedTemplates.add(t.slug);
    templateSlugs.add(t.slug);
    const cur = state.templates.find((x) => x.slug === t.slug);
    const values = { slug: t.slug, name: t.name, subject: t.subject, bodyHtml: t.body_html, bodyText: t.body_text ?? null, category: t.category ?? null };
    if (!cur) {
      ops.push({ op: "upsertTemplate", id: deps.newId(), create: true, values });
      changes.push({ kind: "template", key: t.slug, action: "create" });
      continue;
    }
    const fields = diffFields({ ...cur } as unknown as Record<string, unknown>, values, ["name", "subject", "bodyHtml", "bodyText", "category"]);
    if (cur.isActive === false) fields.push("isActive");
    if (fields.length > 0) {
      ops.push({ op: "upsertTemplate", id: cur.id, create: false, values });
      changes.push({ kind: "template", key: t.slug, action: "update", fields });
    }
  }

  // --- Flows -----------------------------------------------------------------
  const listedFlows = new Set<string>();
  const remainingTemplateRefs = new Set<string>();
  for (const f of config.flows ?? []) {
    listedFlows.add(f.slug);
    const cur = state.flows.find((x) => x.slug === f.slug);
    if (cur && cur.status === "archived") {
      errors.push(`flows.${f.slug}: the flow with this slug is archived; use a new slug`);
      continue;
    }
    let topicId: string | null = null;
    if (f.topic) {
      const id = topicIdBySlug.get(f.topic);
      if (!id || (prune && config.topics && !listedTopics.has(f.topic))) {
        errors.push(`flows.${f.slug}: unknown topic '${f.topic}'`);
        continue;
      }
      topicId = id;
      const listed = (config.topics ?? []).find((t) => t.slug === f.topic);
      const mirror = listed ? listed.mirror_only === true : state.topics.find((t) => t.slug === f.topic)?.mirrorOnly === true;
      if (mirror) {
        errors.push(`flows.${f.slug}: topic '${f.topic}' is mirror_only; no flow may send on it`);
        continue;
      }
    } else if (f.topic === undefined && cur) {
      topicId = cur.topicId;
    }
    if (f.email_template && !builtinLayout(f.email_template) && !isCustomLayoutRef(f.email_template)) {
      errors.push(`flows.${f.slug}: unknown email template '${f.email_template}'`);
      continue;
    }
    flowWarnings(f, s, state, warnings);
    const sources = (s.data_sources ?? (state.settings.data_sources as Record<string, { modes?: string[] }> | undefined) ?? {}) as Record<string, { modes?: string[] }>;
    for (const step of f.steps ?? []) {
      if (step.type === "choose" && state.hasLlm === false) {
        errors.push(`flows.${f.slug}: step ${step.order} is a choose step, which needs an LLM; configure one for this product first`);
      }
      const contexts = [...(step.context ?? []), ...(step.candidates ?? []).flatMap((c) => c.context ?? [])];
      for (const ctxEntry of contexts) {
        const src = sources[ctxEntry.source];
        if (!src) errors.push(`flows.${f.slug}: step ${step.order} uses unknown data source '${ctxEntry.source}'`);
        else if (ctxEntry.mode && Array.isArray(src.modes) && !src.modes.includes(ctxEntry.mode)) {
          errors.push(`flows.${f.slug}: step ${step.order} uses mode '${ctxEntry.mode}', which data source '${ctxEntry.source}' does not list`);
        }
      }
      for (const c of step.candidates ?? []) {
        if (c.template_ref) {
          remainingTemplateRefs.add(c.template_ref);
          if (!templateSlugs.has(c.template_ref)) errors.push(`flows.${f.slug}: step ${step.order} candidate '${c.action_type}' references unknown template '${c.template_ref}'`);
        }
      }
      if (step.template_ref) {
        remainingTemplateRefs.add(step.template_ref);
        if (!templateSlugs.has(step.template_ref)) {
          errors.push(`flows.${f.slug}: step ${step.order} references unknown template '${step.template_ref}'`);
        }
      }
      // P5b: allowed_links name links of settings.links.
      const links = (s.links ?? (state.settings.links as Record<string, string> | undefined) ?? {}) as Record<string, string>;
      const names = [...(step.allowed_links ?? []), ...(step.candidates ?? []).flatMap((c) => c.allowed_links ?? [])];
      for (const n of names) {
        if (!(n in links)) errors.push(`flows.${f.slug}: step ${step.order} allows link '${n}', which settings.links does not name`);
      }
      // P5b: single_cta on a fixed template: at most one link in the template.
      if (step.single_cta) {
        for (const ref of [step.template_ref, ...(step.candidates ?? []).map((c) => c.template_ref)]) {
          if (!ref) continue;
          const body = (config.templates ?? []).find((t) => t.slug === ref)?.body_html ?? state.templates.find((t) => t.slug === ref)?.bodyHtml;
          if (body === undefined) continue;
          const hrefs = new Set([...body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!).filter((h) => !h.startsWith("mailto:")));
          if (hrefs.size > 1) errors.push(`flows.${f.slug}: step ${step.order} is single_cta but template '${ref}' has ${hrefs.size} links`);
        }
      }
    }
    const values = flowValues(f, cur, topicId);
    if (!cur) {
      ops.push({ op: "upsertFlow", id: deps.newId(), create: true, values, compile: values.promptSource !== null });
      changes.push({ kind: "flow", key: f.slug, action: "create" });
      continue;
    }
    const current: Record<string, unknown> = {
      name: cur.name,
      description: cur.description,
      status: cur.status,
      triggerType: cur.triggerType,
      triggerConfig: cur.triggerConfig,
      steps: cur.steps,
      compiledPlan: cur.compiledPlan,
      promptSource: cur.promptSource,
      contentMode: cur.contentMode,
      approvalMode: cur.approvalMode,
      flowClass: cur.flowClass,
      priority: cur.priority ?? 0,
      reentryPolicy: cur.reentryPolicy,
      reentryCooldownDays: cur.reentryCooldownDays ?? 30,
      topicId: cur.topicId,
      emailTemplate: cur.emailTemplate ?? null,
    };
    const keys = ["name", "description", "status", "triggerType", "triggerConfig", "contentMode", "approvalMode", "flowClass", "priority", "reentryPolicy", "reentryCooldownDays", "topicId", "emailTemplate"];
    if (values.promptSource !== null) keys.push("promptSource");
    else keys.push("steps", "compiledPlan", "promptSource");
    const fields = diffFields(current, values as unknown as Record<string, unknown>, keys);
    if (fields.length === 0) continue;
    const recompile = values.promptSource !== null && fields.includes("promptSource");
    if (values.promptSource !== null && !recompile) {
      // Prompt unchanged: keep the compiled plan the compile worker wrote.
      values.compiledPlan = (cur.compiledPlan as Record<string, unknown> | null) ?? null;
      values.compileStatus = null;
      values.steps = Array.isArray(cur.steps) ? (cur.steps as unknown[]) : [];
    }
    ops.push({ op: "upsertFlow", id: cur.id, create: false, values, compile: recompile });
    changes.push({ kind: "flow", key: f.slug, action: "update", fields });
  }

  // --- Webhooks and the analytics sink --------------------------------------
  const listedWebhooks = new Set<string>();
  for (const w of config.webhooks ?? []) {
    listedWebhooks.add(w.slug);
    if (w.slug === ANALYTICS_ENDPOINT_SLUG) {
      errors.push(`webhooks.${w.slug}: the slug '${ANALYTICS_ENDPOINT_SLUG}' is reserved for settings.analytics`);
      continue;
    }
    const cur = state.endpoints.find((e) => e.slug === w.slug && e.kind === "webhook");
    const values = {
      slug: w.slug,
      kind: "webhook",
      url: w.url,
      events: [...w.events].sort(),
      enabled: w.enabled ?? true,
      config: w.batch_interval_minutes !== undefined ? { batch_interval_minutes: w.batch_interval_minutes } : null,
    };
    if (!cur) {
      const secret = w.secret ?? deps.newSecret();
      if (!w.secret) generatedSecrets[w.slug] = secret;
      ops.push({ op: "upsertEndpoint", id: deps.newId(), create: true, values, secret });
      changes.push({ kind: "webhook", key: w.slug, action: "create" });
      continue;
    }
    const fields = diffFields({ ...cur, events: [...cur.events].sort() } as unknown as Record<string, unknown>, values, ["url", "events", "enabled", "config"]);
    const secretChanged = w.secret !== undefined && (cur.secret === null || deps.readSecret(cur.secret) !== w.secret);
    if (secretChanged) fields.push("secret");
    if (fields.length > 0) {
      ops.push({ op: "upsertEndpoint", id: cur.id, create: false, values, ...(secretChanged ? { secret: w.secret } : {}) });
      changes.push({ kind: "webhook", key: w.slug, action: "update", fields });
    }
  }
  const analytics = s.analytics;
  const curAnalytics = state.endpoints.find((e) => e.kind === "analytics");
  if (analytics) {
    const values = {
      slug: ANALYTICS_ENDPOINT_SLUG,
      kind: "analytics",
      url: analytics.endpoint,
      events: [...ANALYTICS_SOURCE_EVENTS].sort(),
      enabled: true,
      config: clean({ sink: analytics.sink, site_key: analytics.site_key }),
    };
    if (!curAnalytics) {
      ops.push({ op: "upsertEndpoint", id: deps.newId(), create: true, values, ...(analytics.secret ? { secret: analytics.secret } : {}) });
      changes.push({ kind: "analytics", key: ANALYTICS_ENDPOINT_SLUG, action: "create" });
    } else {
      const fields = diffFields(
        { ...curAnalytics, events: [...curAnalytics.events].sort() } as unknown as Record<string, unknown>,
        values,
        ["url", "events", "enabled", "config"],
      );
      const secretChanged = analytics.secret !== undefined && (curAnalytics.secret === null || deps.readSecret(curAnalytics.secret) !== analytics.secret);
      if (secretChanged) fields.push("secret");
      if (fields.length > 0) {
        ops.push({ op: "upsertEndpoint", id: curAnalytics.id, create: false, values, ...(secretChanged ? { secret: analytics.secret } : {}) });
        changes.push({ kind: "analytics", key: ANALYTICS_ENDPOINT_SLUG, action: "update", fields });
      }
    }
  } else if (analytics === null && curAnalytics) {
    ops.push({ op: "deleteEndpoint", id: curAnalytics.id });
    changes.push({ kind: "analytics", key: ANALYTICS_ENDPOINT_SLUG, action: "delete" });
  }

  // --- Prune (opt-in): only kinds the document lists --------------------------
  if (prune) {
    if (config.flows) {
      for (const f of state.flows) {
        if (f.status === "archived" || (f.slug !== null && listedFlows.has(f.slug))) continue;
        ops.push({ op: "archiveFlow", id: f.id });
        changes.push({ kind: "flow", key: f.slug ?? `id:${f.id}`, action: "archive" });
      }
    }
    if (config.webhooks) {
      for (const e of state.endpoints) {
        if (e.kind !== "webhook" || listedWebhooks.has(e.slug)) continue;
        ops.push({ op: "deleteEndpoint", id: e.id });
        changes.push({ kind: "webhook", key: e.slug, action: "delete" });
      }
    }
    if (config.templates) {
      // Templates still used by a flow that stays (listed, or kept because
      // flows are not listed) are kept.
      const keptFlows = config.flows ? [] : state.flows.filter((f) => f.status !== "archived");
      for (const f of keptFlows) {
        for (const step of Array.isArray(f.steps) ? (f.steps as Array<{ template_ref?: string }>) : []) {
          if (step.template_ref) remainingTemplateRefs.add(step.template_ref);
        }
      }
      for (const t of state.templates) {
        if (listedTemplates.has(t.slug) || remainingTemplateRefs.has(t.slug)) continue;
        ops.push({ op: "deleteTemplate", id: t.id });
        changes.push({ kind: "template", key: t.slug, action: "delete" });
      }
    }
    if (config.topics) {
      for (const t of state.topics) {
        if (listedTopics.has(t.slug)) continue;
        // Any flow row (archived ones too) keeps a reference to its topic.
        const usedBy = state.flows.some((f) => f.topicId === t.id) || (config.flows ?? []).some((f) => f.topic === t.slug);
        if (usedBy) {
          errors.push(`prune: topic '${t.slug}' is used by a flow; keep it in the document`);
          continue;
        }
        ops.push({ op: "deleteTopic", id: t.id });
        changes.push({ kind: "topic", key: t.slug, action: "delete" });
      }
    }
  }

  if (Object.keys(patch).length > 0) ops.push({ op: "setSettings", patch });
  return { changes, ops, errors, warnings, generatedSecrets };
}

/**
 * P5b: warnings for a flow that applies but probably does not do what the
 * document means: trigger keys the trigger type does not read, date
 * triggers on traits missing from settings.date_traits, and long date
 * schedules in the nurture class (they hold the contact's one nurture slot).
 */
function flowWarnings(f: ConfigFlow, s: NonNullable<ClarosConfig["settings"]>, state: ConfigState, warnings: string[]): void {
  const known = TRIGGER_KEYS[f.trigger.type] ?? [];
  for (const k of Object.keys(f.trigger)) {
    if (k === "type" || known.includes(k)) continue;
    warnings.push(`flows.${f.slug}: trigger key '${k}' is not read by ${f.trigger.type} triggers and is ignored`);
  }
  if (f.trigger.type === "date_property" || f.trigger.type === "date_schedule") {
    const trait = f.trigger.type === "date_property" ? f.trigger.property : f.trigger.anchor;
    const dateTraits = (s.date_traits ?? (state.settings.date_traits as string[] | undefined) ?? []) as string[];
    if (trait && !dateTraits.includes(trait)) {
      warnings.push(`flows.${f.slug}: '${trait}' is not in settings.date_traits, so the trigger never fires`);
    }
    if (f.trigger.type === "date_schedule" && (f.flow_class ?? "nurture") === "nurture") {
      warnings.push(`flows.${f.slug}: a nurture-class date schedule holds the contact's nurture slot while it runs; use flow_class "scheduled" for long schedules`);
    }
  }
}

function flowValues(f: ConfigFlow, cur: StateFlow | undefined, topicId: string | null): FlowValues {
  const { type, ...triggerConfig } = f.trigger;
  const steps = (f.steps ?? []) as unknown[];
  const allFixed = f.steps !== undefined && f.steps.every((s) => typeof s.template_ref === "string");
  const compiledPlan = f.steps
    ? clean({
        trigger: { type, condition: triggerConfig },
        steps: f.steps,
        exit_conditions: f.exit_conditions && f.exit_conditions.length > 0 ? f.exit_conditions : undefined,
      })
    : null;
  return {
    slug: f.slug,
    name: f.name,
    description: f.description ?? null,
    status: f.status ?? cur?.status ?? "active",
    triggerType: type,
    triggerConfig: triggerConfig as Record<string, unknown>,
    steps,
    compiledPlan,
    compileStatus: f.steps ? "ready" : "pending",
    promptSource: f.prompt ?? null,
    contentMode: f.content_mode ?? (allFixed ? "fixed_content" : "ai_drafted"),
    approvalMode: f.approval_mode ?? "require",
    flowClass: f.flow_class ?? "nurture",
    priority: f.priority ?? 0,
    reentryPolicy: f.reentry?.policy ?? "cooldown",
    reentryCooldownDays: f.reentry?.cooldown_days ?? 30,
    topicId,
    // Absent keeps the flow's current template, like topic.
    emailTemplate: f.email_template !== undefined ? f.email_template : (cur?.emailTemplate ?? null),
  };
}
