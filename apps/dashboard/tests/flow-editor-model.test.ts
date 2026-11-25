/**
 * Flow editor draft model: drafts from stored flows (config-applied plans
 * with template refs), step modes and switching, delays, the header
 * summary, problems before saving, the save diff, unknown template
 * variables, and the starting recipes.
 */
import { describe, it, expect } from "vitest";
import type { Flow, StepCopy } from "../src/api.js";
import { cleanTriggerConfig } from "../src/lib/flow-model.js";
import {
  contentModeFor,
  cumulativeMinutes,
  describeDelay,
  draftChanges,
  draftFromFlow,
  draftProblems,
  emptyDraft,
  fillSample,
  hasChanges,
  moveStep,
  newCopySlug,
  newStep,
  parseDelay,
  planBody,
  stepMode,
  summarizeFlow,
  switchStepMode,
  unknownVariables,
  variablesWithoutFallback,
} from "../src/lib/flow-editor-model.js";
import { RECIPES, draftFromRecipe } from "../src/lib/flow-recipes.js";

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: "f1", tenant_id: "t1", name: "Welcome (free sign-up)", description: null, priority: 50,
    trigger_type: "event", trigger_config: { event: "signed_up", where: [{ trait: { key: "plan_tier", op: "eq", value: "free" } }] },
    steps: [], source: "config", slug: "welcome_free", content_mode: "fixed_content", status: "active", approval_mode: "require",
    flow_class: "nurture", reentry_policy: "once", reentry_cooldown_days: 30, prompt_source: null,
    compiled_plan: {
      trigger: { type: "event", condition: { event: "signed_up" } },
      steps: [
        { order: 2, action_type: "tips", delay: "2d", window_policy: "respect_window", brain_instruction: "One tip." },
        { order: 1, action_type: "welcome_free", delay: "0m", window_policy: "immediate", template_ref: "welcome_free" },
      ],
      exit_conditions: [{ event: "subscription_started" }],
    },
    compiled_at: "2026-11-25T09:49:00Z", compile_status: "ready", compile_error: null, topic_id: null,
    created_at: "2026-11-25T09:49:00Z", updated_at: "2026-11-25T09:49:00Z",
    ...over,
  };
}

const stored: Record<string, StepCopy> = { welcome_free: { subject: "Welcome", body_html: "<p>Hi {{contact.first_name|there}}</p>", body_text: null } };
const copyOf = (slug: string) => stored[slug];

describe("draftFromFlow", () => {
  it("reads the compiled plan in order, with exits and settings", () => {
    const d = draftFromFlow(flow());
    expect(d.steps.map((s) => s.action_type)).toEqual(["welcome_free", "tips"]);
    expect(d.exits).toEqual([{ event: "subscription_started" }]);
    expect(d.prompt).toBeNull();
    expect(d.priority).toBe(50);
    expect(stepMode(d.steps[0]!)).toBe("fixed");
    expect(stepMode(d.steps[1]!)).toBe("ai");
    expect(stepMode({ type: "choose", candidates: [] })).toBe("choose");
  });

  it("round-trips: an untouched draft has no changes", () => {
    const d = draftFromFlow(flow());
    const c = draftChanges(d, draftFromFlow(flow()), cleanTriggerConfig);
    expect(hasChanges(c)).toBe(false);
  });
});

describe("steps", () => {
  it("adds steps after the last one with sane defaults", () => {
    expect(newStep([], "fixed", "s1")).toEqual({ order: 1, action_type: "email_1", delay: "0m", window_policy: "respect_window", template_ref: "s1" });
    expect(newStep([{ order: 4 }], "ai", "x")).toMatchObject({ order: 5, delay: "1d", brain_instruction: "" });
  });

  it("switches modes and back without losing the other side, and never saves the stash", () => {
    const ai = { order: 1, action_type: "a", delay: "0m", brain_instruction: "Say hi." };
    const fixed = switchStepMode(ai, "fixed", "copy-1");
    expect(fixed.template_ref).toBe("copy-1");
    expect(fixed.brain_instruction).toBeUndefined();
    const back = switchStepMode(fixed, "ai", "copy-2");
    expect(back.brain_instruction).toBe("Say hi.");
    expect(back.template_ref).toBeUndefined();
    expect(switchStepMode(back, "fixed", "copy-3").template_ref).toBe("copy-1");
    expect(planBody({ steps: [back], exits: [] }).steps[0]).toEqual({ order: 1, action_type: "a", delay: "0m", brain_instruction: "Say hi." });
  });

  it("moves a step and its order together", () => {
    const moved = moveStep([{ order: 1, action_type: "a" }, { order: 2, action_type: "b" }], 1, -1);
    expect(moved).toEqual([{ order: 1, action_type: "b" }, { order: 2, action_type: "a" }]);
    expect(moveStep([{ order: 1 }], 0, -1)).toEqual([{ order: 1 }]);
  });

  it("makes template slugs that pass the config slug rule", () => {
    expect(newCopySlug(() => "AbC9!")).toBe("flow-copy-abc9");
    expect(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(newCopySlug())).toBe(true);
  });
});

describe("delays", () => {
  it("parses, describes and adds up", () => {
    expect(parseDelay("3d")).toEqual({ n: 3, unit: "d" });
    expect(parseDelay("bogus")).toEqual({ n: 0, unit: "d" });
    expect(describeDelay("0m")).toBe("right away");
    expect(describeDelay("1d")).toBe("1 day later");
    expect(describeDelay("4h")).toBe("4 hours later");
    expect(cumulativeMinutes([{ delay: "0m" }, { delay: "1d" }, { delay: "2h" }])).toEqual([0, 1440, 1560]);
  });
});

describe("summarizeFlow", () => {
  it("says what the flow does in one go", () => {
    const s = summarizeFlow(draftFromFlow(flow()));
    expect(s).toBe("When the event signed_up is received, if plan_tier is free, send 2 emails over 2 days. Stops early if subscription_started occurs. You approve each email before it sends.");
    expect(summarizeFlow({ ...emptyDraft(), approval_mode: "auto" })).toContain("nothing is sent yet");
  });
});

describe("draftProblems", () => {
  it("is empty for a complete draft", () => {
    expect(draftProblems(draftFromFlow(flow()), copyOf)).toEqual([]);
  });

  it("points at the email that needs work", () => {
    const d = draftFromFlow(flow());
    d.steps[1] = { ...d.steps[1]!, brain_instruction: "  " };
    d.steps.push({ order: 3, action_type: "x", delay: "1d", template_ref: "new-copy" });
    d.copies["new-copy"] = { subject: "Hi {{contact.company}}", body_html: "", body_text: null };
    const p = draftProblems(d, (s) => d.copies[s] ?? stored[s]);
    expect(p.filter((x) => x.where === 1).map((x) => x.message)).toEqual(["Email 2: tell the AI what this email should do."]);
    expect(p.filter((x) => x.where === 2).map((x) => x.message)).toEqual([
      "Email 3: write the body.",
      "Email 3: {{contact.company}} is not a variable Claros knows; the email would fail to render.",
    ]);
  });

  it("needs a name and a complete trigger", () => {
    const p = draftProblems({ ...emptyDraft(), name: " " }, copyOf);
    expect(p.map((x) => x.where)).toEqual(["name", "trigger"]);
  });
});

describe("variables", () => {
  it("flags variables the renderer does not know", () => {
    expect(unknownVariables("{{contact.first_name|there}} {{contact.company}} {{traits.plan}} {{links.setup_url}} {{#context.leads}}{{name}}{{/context.leads}} {{event}}")).toEqual(["contact.company", "name", "event"]);
  });

  it("lists personal variables without a fallback", () => {
    expect(variablesWithoutFallback("{{contact.first_name}} {{contact.last_name|}} {{tenant.name}} {{traits.plan}}")).toEqual(["contact.first_name", "traits.plan"]);
  });

  it("fills sample values and keeps unknown ones visible", () => {
    expect(fillSample("Hi {{contact.first_name|there}}, {{traits.plan|friend}} {{x.y}}", { "contact.first_name": "Ada" })).toBe("Hi Ada, friend {{x.y}}");
  });
});

describe("draftChanges", () => {
  it("collects settings, trigger, used copies and plan changes", () => {
    const saved = draftFromFlow(flow());
    const draft = { ...draftFromFlow(flow()), name: " Welcome ", priority: 10 };
    draft.trigger = { type: "event", config: { event: "signed_up" } };
    draft.copies = { welcome_free: { subject: "New", body_html: "<p>x</p>", body_text: null }, orphan: { subject: "a", body_html: "b", body_text: null } };
    const c = draftChanges(saved, draft, cleanTriggerConfig);
    expect(c.patch).toEqual({ name: "Welcome", priority: 10, trigger_type: "event", trigger_config: { event: "signed_up" } });
    expect(Object.keys(c.copies)).toEqual(["welcome_free"]);
    expect(c.plan).toBe(true);
  });

  it("content mode follows the emails", () => {
    const d = draftFromFlow(flow());
    expect(contentModeFor(d)).toBe("ai_drafted");
    expect(contentModeFor({ ...d, steps: [d.steps[0]!] })).toBe("fixed_content");
    expect(contentModeFor({ ...d, prompt: "x", steps: [d.steps[0]!] })).toBe("ai_drafted");
  });
});

describe("recipes", () => {
  it("build complete drafts with valid copy", () => {
    let n = 0;
    for (const r of RECIPES) {
      const d = draftFromRecipe(r, () => `r-${++n}`);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.steps.length).toBeGreaterThan(0);
      const problems = draftProblems(d, (s) => d.copies[s]);
      expect(problems, r.id).toEqual([]);
      for (const c of Object.values(d.copies)) {
        expect(unknownVariables(`${c.subject} ${c.body_html}`), r.id).toEqual([]);
        expect(variablesWithoutFallback(`${c.subject} ${c.body_html}`), r.id).toEqual([]);
      }
    }
  });
});
