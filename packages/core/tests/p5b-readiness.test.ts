/**
 * P5b pure logic: condition combinators and lists, audience leaves, the
 * config schema additions (event lists, lifecycle segments, scheduled class,
 * step fields, settings), planConfig checks and warnings, step presentation.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateAudienceCondition,
  evaluateConditionTree,
  conditionDepth,
  stepConditionSchema,
  planExitConditionSchema,
  clarosConfigSchema,
  planConfig,
  stepPresentation,
  matchesEventTrigger,
  matchesLifecycleTransition,
  pendingApprovalBatch,
  endpointBatchMinutes,
  isLifecycleSegmentTriggerConfig,
  toFlowClass,
  type ConfigState,
  type ContactConditionContext,
} from "../src/index.js";

function ctx(traits: Record<string, unknown>, sends = 0, state: string | null = "engaged"): ContactConditionContext {
  return { now: new Date("2026-11-20T00:00:00Z"), traits: async () => traits, countSends: async () => sends, lifecycleState: async () => state };
}
const free = { trait: { key: "plan", op: "eq", value: "free" } };

describe("condition combinators", () => {
  it("all, any, not and lists", async () => {
    const c = ctx({ plan: "free" }, 0, "dormant");
    expect(await evaluateAudienceCondition({ all: [free, { first_contact: true }, { lifecycle_state: "dormant" }] }, c)).toBe(true);
    expect(await evaluateAudienceCondition({ not: { all: [free, { first_contact: true }] } }, c)).toBe(false);
    expect(await evaluateAudienceCondition({ any: [{ lifecycle_state: "engaged" }, free] }, c)).toBe(true);
    expect(await evaluateAudienceCondition([free, { lifecycle_state_not: "dormant" }], c)).toBe(false);
    expect(await evaluateAudienceCondition(free, c)).toBe(true);
    expect(await evaluateAudienceCondition(undefined, c)).toBe(true);
    expect(await evaluateAudienceCondition([], c)).toBe(true);
  });

  it("malformed or undecidable conditions are null", async () => {
    const c = ctx({});
    expect(await evaluateAudienceCondition({ all: [] }, c)).toBeNull();
    expect(await evaluateAudienceCondition({ nope: 1 }, c)).toBeNull();
    expect(await evaluateAudienceCondition({ event_since_step: "x" }, c)).toBeNull();
    const noState: ContactConditionContext = { now: new Date(), traits: async () => ({}), countSends: async () => 0 };
    expect(await evaluateAudienceCondition({ lifecycle_state: "x" }, noState)).toBeNull();
  });

  it("limits nesting to 4 combinators", () => {
    let deep: unknown = free;
    for (let i = 0; i < 4; i++) deep = { not: deep };
    expect(conditionDepth(deep)).toBe(4);
    expect(stepConditionSchema.safeParse(deep).success).toBe(true);
    expect(stepConditionSchema.safeParse({ not: deep }).success).toBe(false);
  });

  it("step conditions take leaves, combinators and lists; plan exits take combinators", () => {
    expect(stepConditionSchema.safeParse([{ event_since_step: "x" }, { any: [free, { date_unchanged: true }] }]).success).toBe(true);
    expect(stepConditionSchema.safeParse({ all: [{ event: "x" }] }).success).toBe(false);
    expect(planExitConditionSchema.safeParse({ any: [{ event: "paid" }, { trait: { key: "a", op: "exists" } }] }).success).toBe(true);
    expect(planExitConditionSchema.safeParse({ not: { event_since_step: "x" } }).success).toBe(false);
  });

  it("evaluateConditionTree short-circuits", async () => {
    let calls = 0;
    const leaf = async (c: unknown) => {
      calls++;
      return (c as { v: boolean }).v;
    };
    expect(await evaluateConditionTree({ any: [{ v: true }, { v: false }] }, leaf)).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("triggers", () => {
  const flow = (triggerType: string, triggerConfig: unknown) => ({ id: "f", tenantId: "t", priority: 0, triggerType, triggerConfig, flowClass: "nurture", reentryPolicy: "once", reentryCooldownDays: 0 }) as never;
  it("event triggers take a list of names", () => {
    expect(matchesEventTrigger(flow("event", { event: ["a", "b"] }), "b")).toBe(true);
    expect(matchesEventTrigger(flow("event", { event: ["a", "b"] }), "c")).toBe(false);
    expect(matchesEventTrigger(flow("event", { event: "a" }), "a")).toBe(true);
  });
  it("lifecycle_transition without from matches any previous state", () => {
    expect(matchesLifecycleTransition(flow("lifecycle_transition", { to: "churned" }), "dormant", "churned")).toBe(true);
    expect(matchesLifecycleTransition(flow("lifecycle_transition", { from: "at_risk", to: "churned" }), "dormant", "churned")).toBe(false);
  });
  it("segment by lifecycle state", () => {
    expect(isLifecycleSegmentTriggerConfig({ lifecycle_states: ["engaged"] })).toBe(true);
    expect(isLifecycleSegmentTriggerConfig({ engagement_depths: ["power"] })).toBe(true);
    expect(isLifecycleSegmentTriggerConfig({ tenure_bucket: "new" })).toBe(false);
    expect(toFlowClass("scheduled")).toBe("scheduled");
    expect(toFlowClass("bogus")).toBe("nurture");
  });
});

function emptyState(): ConfigState {
  return { settings: {}, locale: null, configVersion: 1, topics: [], templates: [], flows: [], transports: [], endpoints: [] };
}
let n = 0;
const deps = { newId: () => `id-${++n}`, newSecret: () => "whsec_generated", readSecret: (e: string) => e };
const step = { order: 1, action_type: "a", delay: "0m", brain_instruction: "x" };

describe("config schema and plan (P5b)", () => {
  it("accepts the new trigger, step, topic, webhook and settings fields", () => {
    const doc = {
      settings: {
        links: { home: "https://x.example" },
        lifecycle: { natural_frequency_days: 7, dormant_days: 30, churned_days: 45 },
        brain: { assess: { enabled: true, threshold: 6 } },
        llm_daily_token_budget: 400000,
        approvals: { daily_digest: true },
        date_traits: ["first_paid_at"],
      },
      topics: [{ slug: "mirror", name: "Mirror", kind: "marketing", mirror_only: true }],
      webhooks: [{ slug: "app", url: "https://app.example/hook", events: ["contact.subscribed", "message.pending_approval"], batch_interval_minutes: 30 }],
      flows: [
        { slug: "a", name: "A", flow_class: "scheduled", trigger: { type: "date_schedule", anchor: "first_paid_at", offsets: ["1d"], max_sends: 3, where: { not: free } },
          steps: [{ ...step, from_name: "Umut", reply_to: "u@x.example", eyebrow: "TIP", preheader: "Hi", allowed_links: ["home"], single_cta: true, condition: [free, { lifecycle_state: "engaged" }] }] },
        { slug: "b", name: "B", trigger: { type: "event", event: ["up", "down"] }, steps: [step] },
        { slug: "c", name: "C", trigger: { type: "segment", lifecycle_states: ["engaged", "at_risk"], where: [free] }, steps: [step] },
        { slug: "d", name: "D", trigger: { type: "manual", where: { any: [free] } }, steps: [step] },
      ],
    };
    const parsed = clarosConfigSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    const plan = planConfig(parsed.success ? parsed.data : (null as never), emptyState(), deps);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    const settings = plan.ops.find((o) => o.op === "setSettings") as { patch: Record<string, unknown> };
    expect(Object.keys(settings.patch).sort()).toEqual(["approvals", "brain", "date_traits", "lifecycle", "links", "llm_daily_token_budget"]);
    const ep = plan.ops.find((o) => o.op === "upsertEndpoint") as { values: { config: unknown } };
    expect(ep.values.config).toEqual({ batch_interval_minutes: 30 });
    const topic = plan.ops.find((o) => o.op === "upsertTopic") as { values: { mirrorOnly: boolean } };
    expect(topic.values.mirrorOnly).toBe(true);
  });

  it("rejects bad segment triggers and settings", () => {
    const f = (trigger: unknown) => ({ flows: [{ slug: "s", name: "S", trigger, steps: [step] }] });
    expect(clarosConfigSchema.safeParse(f({ type: "segment" })).success).toBe(false);
    expect(clarosConfigSchema.safeParse(f({ type: "segment", tenure_bucket: "new" })).success).toBe(false);
    expect(clarosConfigSchema.safeParse(f({ type: "segment", tenure_bucket: "new", recency_bucket: "active", lifecycle_states: ["engaged"] })).success).toBe(false);
    expect(clarosConfigSchema.safeParse(f({ type: "segment", lifecycle_states: ["nope"] })).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ settings: { lifecycle: { dormant_days: 30, churned_days: 20 } } }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ settings: { brain: { assess: { threshold: 11 } } } }).success).toBe(false);
  });

  it("refuses a flow on a mirror_only topic, unknown allowed_links and multi-link single_cta templates", () => {
    const doc = clarosConfigSchema.parse({
      settings: { links: { home: "https://x.example" } },
      topics: [{ slug: "mirror", name: "Mirror", kind: "marketing", mirror_only: true }],
      templates: [{ slug: "t", name: "T", subject: "S", body_html: '<a href="https://a.example">a</a> <a href="https://b.example">b</a>' }],
      flows: [
        { slug: "m", name: "M", topic: "mirror", trigger: { type: "event", event: "x" }, steps: [step] },
        { slug: "l", name: "L", trigger: { type: "event", event: "x" }, steps: [{ ...step, allowed_links: ["nope"] }] },
        { slug: "c", name: "C", trigger: { type: "event", event: "x" }, steps: [{ order: 1, action_type: "a", delay: "0m", template_ref: "t", single_cta: true }] },
      ],
    });
    const plan = planConfig(doc, emptyState(), deps);
    expect(plan.errors).toEqual([
      "flows.m: topic 'mirror' is mirror_only; no flow may send on it",
      "flows.l: step 1 allows link 'nope', which settings.links does not name",
      "flows.c: step 1 is single_cta but template 't' has 2 links",
    ]);
  });

  it("warns about ignored trigger keys, undeclared date traits and nurture schedules", () => {
    const doc = clarosConfigSchema.parse({
      flows: [
        { slug: "seg", name: "Seg", trigger: { type: "segment", lifecycle_states: ["engaged"], scan: "daily" }, steps: [step] },
        { slug: "sched", name: "Sched", trigger: { type: "date_schedule", anchor: "first_paid_at", offsets: ["1d"], max_sends: 2 }, steps: [step] },
      ],
    });
    const plan = planConfig(doc, emptyState(), deps);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([
      "flows.seg: trigger key 'scan' is not read by segment triggers and is ignored",
      "flows.sched: 'first_paid_at' is not in settings.date_traits, so the trigger never fires",
      'flows.sched: a nurture-class date schedule holds the contact\'s nurture slot while it runs; use flow_class "scheduled" for long schedules',
    ]);
  });
});

describe("step presentation and batching", () => {
  it("reads the step's persona fields; a choose candidate's eyebrow wins", () => {
    const plan = { steps: [{ order: 1, from_name: "Umut", reply_to: "u@x.example", eyebrow: "TIP", preheader: "Hi", candidates: [{ action_type: "tip", eyebrow: "QUICK TIP" }] }] };
    expect(stepPresentation(plan, 1, null)).toEqual({ fromName: "Umut", replyTo: "u@x.example", eyebrow: "TIP", preheader: "Hi" });
    expect(stepPresentation(plan, 1, "tip").eyebrow).toBe("QUICK TIP");
    expect(stepPresentation(plan, 2, null)).toEqual({ fromName: null, replyTo: null, eyebrow: null, preheader: null });
  });
  it("pending-approval windows follow batch_interval_minutes", () => {
    const at = new Date("2026-11-20T12:05:00Z");
    expect(pendingApprovalBatch(at).deliverAt.toISOString()).toBe("2026-11-20T12:15:00.000Z");
    expect(pendingApprovalBatch(at, endpointBatchMinutes({ batch_interval_minutes: 60 })).deliverAt.toISOString()).toBe("2026-11-20T13:00:00.000Z");
    expect(endpointBatchMinutes(null)).toBe(15);
    expect(endpointBatchMinutes({ batch_interval_minutes: 0 })).toBe(15);
  });
});
