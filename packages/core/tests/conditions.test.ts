/**
 * Trait (G4), history and first_contact (G28) conditions: shapes and pure
 * evaluation.
 */
import { describe, it, expect } from "vitest";
import {
  contactConditionSchema,
  evaluateTrait,
  historySince,
  historyPasses,
  evaluateContactCondition,
  evaluateAllContactConditions,
  cachedConditionContext,
  isContactCondition,
  traitValue,
  stepConditionSchema,
  planExitConditionSchema,
  type SendHistoryFilter,
} from "../src/index.js";

const NOW = new Date("2026-11-20T12:00:00Z");

describe("shapes", () => {
  it("accepts the documented shapes and rejects incomplete ones", () => {
    expect(contactConditionSchema.safeParse({ trait: { key: "plan_tier", op: "in", value: ["pro", "business"] } }).success).toBe(true);
    expect(contactConditionSchema.safeParse({ trait: { key: "icp_configured", op: "exists" } }).success).toBe(true);
    expect(contactConditionSchema.safeParse({ trait: { key: "x", op: "in", value: "pro" } }).success).toBe(false);
    expect(contactConditionSchema.safeParse({ trait: { key: "x", op: "eq" } }).success).toBe(false);
    expect(contactConditionSchema.safeParse({ trait: { key: "x", op: "matches", value: 1 } }).success).toBe(false);
    expect(contactConditionSchema.safeParse({ history: { flow: "welcome", within: "7d", op: "none" } }).success).toBe(true);
    expect(contactConditionSchema.safeParse({ history: { op: "count_lt" } }).success).toBe(false);
    expect(contactConditionSchema.safeParse({ history: { op: "any", within: "1w" } }).success).toBe(false);
    expect(contactConditionSchema.safeParse({ first_contact: true }).success).toBe(true);
    expect(contactConditionSchema.safeParse({ first_contact: "yes" }).success).toBe(false);
  });

  it("is part of step conditions and plan exits", () => {
    expect(stepConditionSchema.safeParse({ trait: { key: "a", op: "eq", value: 1 } }).success).toBe(true);
    expect(stepConditionSchema.safeParse({ history: { action_type: "tip", op: "any" } }).success).toBe(true);
    expect(planExitConditionSchema.safeParse({ trait: { key: "icp_configured", op: "eq", value: true } }).success).toBe(true);
    expect(planExitConditionSchema.safeParse({ first_contact: false }).success).toBe(true);
    expect(stepConditionSchema.safeParse({ lifecycle_state: "engaged" }).success).toBe(true);
  });

  it("isContactCondition looks at the single key", () => {
    expect(isContactCondition({ trait: {} })).toBe(true);
    expect(isContactCondition({ first_contact: true })).toBe(true);
    expect(isContactCondition({ event: "x" })).toBe(false);
    expect(isContactCondition({ trait: {}, event: "x" })).toBe(false);
    expect(isContactCondition(null)).toBe(false);
  });
});

describe("evaluateTrait", () => {
  const traits = { plan_tier: "pro", count: 7, paid: true, nested: { a: { b: "deep" } }, empty: null, since: "2026-11-01T00:00:00Z", n: "5" };
  it("eq / neq with loose scalar equality", () => {
    expect(evaluateTrait({ key: "plan_tier", op: "eq", value: "pro" }, traits)).toBe(true);
    expect(evaluateTrait({ key: "paid", op: "eq", value: true }, traits)).toBe(true);
    expect(evaluateTrait({ key: "n", op: "eq", value: 5 }, traits)).toBe(true);
    expect(evaluateTrait({ key: "plan_tier", op: "neq", value: "free" }, traits)).toBe(true);
    expect(evaluateTrait({ key: "missing", op: "neq", value: "free" }, traits)).toBe(true);
    expect(evaluateTrait({ key: "missing", op: "eq", value: "free" }, traits)).toBe(false);
  });
  it("in / exists / not_exists / dotted paths", () => {
    expect(evaluateTrait({ key: "plan_tier", op: "in", value: ["pro", "business"] }, traits)).toBe(true);
    expect(evaluateTrait({ key: "plan_tier", op: "in", value: ["free"] }, traits)).toBe(false);
    expect(evaluateTrait({ key: "empty", op: "exists" }, traits)).toBe(false);
    expect(evaluateTrait({ key: "empty", op: "not_exists" }, traits)).toBe(true);
    expect(evaluateTrait({ key: "nested.a.b", op: "eq", value: "deep" }, traits)).toBe(true);
    expect(traitValue(traits, "nested.a.x")).toBeUndefined();
    expect(traitValue(null, "a")).toBeUndefined();
  });
  it("gt / lt on numbers, numeric strings and ISO dates; false when not comparable", () => {
    expect(evaluateTrait({ key: "count", op: "gt", value: 5 }, traits)).toBe(true);
    expect(evaluateTrait({ key: "count", op: "lt", value: 5 }, traits)).toBe(false);
    expect(evaluateTrait({ key: "n", op: "lt", value: 6 }, traits)).toBe(true);
    expect(evaluateTrait({ key: "since", op: "lt", value: "2026-11-02T00:00:00Z" }, traits)).toBe(true);
    expect(evaluateTrait({ key: "plan_tier", op: "gt", value: 1 }, traits)).toBe(false);
    expect(evaluateTrait({ key: "missing", op: "lt", value: 1 }, traits)).toBe(false);
  });
});

describe("history", () => {
  it("historySince parses windows", () => {
    expect(historySince("7d", NOW)).toEqual(new Date("2026-11-13T12:00:00Z"));
    expect(historySince("2h", NOW)).toEqual(new Date("2026-11-20T10:00:00Z"));
    expect(historySince("30m", NOW)).toEqual(new Date("2026-11-20T11:30:00Z"));
    expect(historySince(undefined, NOW)).toBeNull();
  });
  it("historyPasses", () => {
    expect(historyPasses({ op: "none" }, 0)).toBe(true);
    expect(historyPasses({ op: "none" }, 1)).toBe(false);
    expect(historyPasses({ op: "any" }, 1)).toBe(true);
    expect(historyPasses({ op: "count_lt", value: 3 }, 2)).toBe(true);
    expect(historyPasses({ op: "count_lt", value: 3 }, 3)).toBe(false);
  });
});

describe("evaluateContactCondition", () => {
  function ctx(traits: Record<string, unknown>, sends: (f: SendHistoryFilter) => number) {
    const calls: SendHistoryFilter[] = [];
    let traitCalls = 0;
    const c = cachedConditionContext({
      now: NOW,
      traits: async () => {
        traitCalls++;
        return traits;
      },
      countSends: async (f) => {
        calls.push(f);
        return sends(f);
      },
    });
    return { c, calls, traitCalls: () => traitCalls };
  }

  it("evaluates each shape through the lookups, with the window and filters", async () => {
    const { c, calls } = ctx({ plan_tier: "pro" }, (f) => (f.flow === "welcome" ? 1 : 0));
    expect(await evaluateContactCondition({ trait: { key: "plan_tier", op: "eq", value: "pro" } }, c)).toBe(true);
    expect(await evaluateContactCondition({ history: { flow: "welcome", within: "7d", op: "any" } }, c)).toBe(true);
    expect(calls[0]).toEqual({ flow: "welcome", actionType: undefined, topic: undefined, since: new Date("2026-11-13T12:00:00Z") });
    expect(await evaluateContactCondition({ history: { topic: "lifecycle", op: "none" } }, c)).toBe(true);
    expect(await evaluateContactCondition({ first_contact: true }, c)).toBe(true);
    expect(await evaluateContactCondition({ first_contact: false }, c)).toBe(false);
    expect(await evaluateContactCondition({ trait: { key: "x", op: "bogus" } }, c)).toBeNull();
  });

  it("evaluateAllContactConditions is AND, null on an invalid entry, and memoizes lookups", async () => {
    const { c, traitCalls } = ctx({ a: 1, b: 2 }, () => 2);
    expect(await evaluateAllContactConditions([{ trait: { key: "a", op: "eq", value: 1 } }, { trait: { key: "b", op: "eq", value: 2 } }], c)).toBe(true);
    expect(await evaluateAllContactConditions([{ trait: { key: "a", op: "eq", value: 1 } }, { history: { op: "count_lt", value: 2 } }], c)).toBe(false);
    expect(await evaluateAllContactConditions([{ nope: 1 }], c)).toBeNull();
    expect(await evaluateAllContactConditions([], c)).toBe(true);
    expect(traitCalls()).toBe(1);
  });
});
