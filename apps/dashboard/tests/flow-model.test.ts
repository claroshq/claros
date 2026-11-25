/**
 * Flow editor model: condition summaries and problems (all / any / not,
 * depth), list normalisation, trigger configs (events list, segment by
 * lifecycle state, date triggers, where) and step cleaning.
 */
import { describe, it, expect } from "vitest";
import {
  cleanStep,
  cleanTriggerConfig,
  conditionKind,
  conditionProblems,
  emptyCondition,
  fromConditionList,
  kindsFor,
  nextOrder,
  parseTraitValue,
  stepProblems,
  summarizeCondition,
  summarizeTrigger,
  toConditionList,
  triggerProblems,
} from "@/lib/flow-model";

const free = { trait: { key: "payment_status", op: "eq", value: "free" } };

describe("conditions", () => {
  it("summarises leaves and combinators", () => {
    expect(summarizeCondition(free)).toBe("payment_status is free");
    expect(summarizeCondition({ not: { all: [free, { lifecycle_state: "dormant" }, { first_contact: true }] } })).toBe(
      "not ((payment_status is free) and (lifecycle state is dormant) and (has never received mail))",
    );
    expect(summarizeCondition({ any: [{ trait: { key: "plan", op: "in", value: ["pro", "business"] } }, { history: { flow: "x", within: "7d", op: "none" } }] })).toBe(
      "(plan is one of pro, business) or (was never sent flow x in the last 7d)",
    );
    expect(summarizeCondition([free, { event: "paid" }])).toBe("(payment_status is free) and (paid occurs)");
    expect(summarizeCondition([])).toBe("always");
  });

  it("finds problems, including nesting deeper than four levels", () => {
    expect(conditionProblems(free)).toEqual([]);
    expect(conditionProblems({ trait: { key: "", op: "eq", value: "x" } })).toEqual(["a trait condition needs a key"]);
    expect(conditionProblems({ history: { op: "count_lt" } })).toEqual(["'fewer than' needs a number"]);
    const deep = { not: { not: { not: { not: free } } } };
    expect(conditionProblems(deep)[0]).toContain("at most 4 levels");
    expect(conditionProblems({ bogus: 1 })[0]).toContain("unknown condition");
  });

  it("normalises a single condition or a list", () => {
    expect(toConditionList(undefined)).toEqual([]);
    expect(toConditionList(free)).toEqual([free]);
    expect(toConditionList([free, free])).toHaveLength(2);
    expect(fromConditionList([])).toBeUndefined();
    expect(fromConditionList([free])).toEqual(free);
    expect(fromConditionList([free, free])).toEqual([free, free]);
  });

  it("offers leaves by scope and builds empty shapes", () => {
    expect(kindsFor("contact")).not.toContain("event");
    expect(kindsFor("step")).toContain("date_unchanged");
    expect(kindsFor("exit")).toContain("lifecycle_state_change");
    expect(conditionKind(emptyCondition("any"))).toBe("any");
    expect(conditionKind({ trait: {}, extra: 1 })).toBeNull();
    expect(parseTraitValue("pro, 3, true", "in")).toEqual(["pro", 3, true]);
    expect(parseTraitValue("42", "gt")).toBe(42);
  });
});

describe("triggers", () => {
  it("keeps one event as a string and several as a list, drops empty where", () => {
    expect(cleanTriggerConfig({ type: "event", config: { event: ["a"], where: [] } })).toEqual({ event: "a" });
    expect(cleanTriggerConfig({ type: "event", config: { event: ["a", "b"], where: [free] } })).toEqual({ event: ["a", "b"], where: free });
  });

  it("segment by lifecycle state drops the grid cell keys", () => {
    expect(cleanTriggerConfig({ type: "segment", config: { lifecycle_states: ["engaged", "at_risk"], engagement_depths: [], tenure_bucket: "new" } })).toEqual({
      lifecycle_states: ["engaged", "at_risk"],
    });
    expect(triggerProblems({ type: "segment", config: { lifecycle_states: [] } })).toEqual(["Pick at least one lifecycle state."]);
    expect(summarizeTrigger("segment", { lifecycle_states: ["engaged"], engagement_depths: ["power"] })).toBe("A contact is engaged with engagement power");
  });

  it("validates date triggers", () => {
    expect(triggerProblems({ type: "date_property", config: { property: "trial_ends_at", offset: "-3d", send_at_local: "09:00" } })).toEqual([]);
    expect(triggerProblems({ type: "date_property", config: { property: "", offset: "3 days" } })).toHaveLength(2);
    expect(triggerProblems({ type: "date_schedule", config: { anchor: "first_paid_at", offsets: ["1d", "3d"], repeat: "30d", max_sends: 7 } })).toEqual([]);
    expect(triggerProblems({ type: "date_schedule", config: { anchor: "a", offsets: ["1 day"], max_sends: 0 } })).toHaveLength(2);
    expect(summarizeTrigger("date_schedule", { anchor: "first_paid_at", offsets: ["1d", "3d"], repeat: "30d", max_sends: 7 })).toBe(
      "Scheduled from first_paid_at at 1d, 3d, then every 30d, up to 7 sends",
    );
  });

  it("manual triggers need nothing, event triggers need a name", () => {
    expect(triggerProblems({ type: "manual", config: {} })).toEqual([]);
    expect(triggerProblems({ type: "event", config: { event: [] } })).toEqual(["Name at least one event."]);
  });
});

describe("steps", () => {
  it("drops empty fields, normalises conditions and orders keys", () => {
    const s = cleanStep({
      delay: "0m", order: 1, action_type: "nudge", type: "send", eyebrow: "", single_cta: false, allowed_links: [],
      condition: [free], kb_select: { category: "tips", tags_any_from_trait: "" }, candidates: [{ action_type: "x" }],
    });
    expect(s).toEqual({ order: 1, action_type: "nudge", delay: "0m", condition: free, kb_select: { category: "tips" } });
    expect(Object.keys(s)).toEqual(["order", "action_type", "delay", "condition", "kb_select"]);
  });

  it("keeps choose candidates and allow_none false", () => {
    const s = cleanStep({ order: 1, action_type: "n", delay: "0m", type: "choose", allow_none: false, candidates: [{ action_type: "tip", when: [], cooldown: "14d", context: [{ source: "leads", mode: "" }] }] });
    expect(s).toEqual({ order: 1, action_type: "n", type: "choose", delay: "0m", candidates: [{ action_type: "tip", cooldown: "14d", context: [{ source: "leads" }] }], allow_none: false });
  });

  it("reports step problems", () => {
    expect(stepProblems([{ order: 1, action_type: "a", delay: "1d" }])).toEqual([]);
    const p = stepProblems([
      { order: 1, action_type: "", delay: "soon", reply_to: "nope" },
      { order: 1, action_type: "b", delay: "0m", type: "choose", candidates: [{ action_type: "x" }, { action_type: "x" }] },
    ]);
    expect(p).toEqual(expect.arrayContaining([
      "Step 1: name the action type.",
      "Step 1: delay looks like 0m, 2h or 3d.",
      "Step 1: reply-to is an email address.",
      "Step 1: the order is used twice.",
      "Step 1: candidate x is listed twice.",
    ]));
    expect(nextOrder([{ order: 2 }, { order: 5 }])).toBe(6);
  });
});
