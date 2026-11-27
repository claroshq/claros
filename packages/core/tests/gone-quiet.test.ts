/**
 * gone_quiet, the new name of the churned lifecycle state (deprecation
 * window): accepted wherever a state is given as input and means the stored
 * churned state; gone_quiet_days is the new name of churned_days.
 */
import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STATE_NAMES,
  storedLifecycleState,
  publicLifecycleState,
  publicStateCounts,
  withPublicStates,
  resolveLifecycleConfig,
} from "../src/lifecycle/index.js";
import { evaluateAudienceCondition, type ContactConditionContext } from "../src/conditions.js";
import { matchesLifecycleTransition, type EnrollableFlow } from "../src/enrollment.js";
import { configLifecycleSchema, configTriggerSchema } from "../src/config/schema.js";

function ctx(state: string): ContactConditionContext {
  return {
    traits: async () => ({}),
    countSends: async () => 0,
    lifecycleState: async () => state,
    now: new Date("2026-11-27T00:00:00Z"),
  };
}

function flow(triggerConfig: unknown): EnrollableFlow {
  return {
    id: "f1",
    tenantId: "t1",
    priority: 0,
    triggerType: "lifecycle_transition",
    triggerConfig,
    flowClass: "nurture",
    reentryPolicy: "once",
    reentryCooldownDays: 0,
  };
}

describe("gone_quiet alias", () => {
  it("maps gone_quiet to the stored churned value and leaves other names alone", () => {
    expect(storedLifecycleState("gone_quiet")).toBe("churned");
    expect(storedLifecycleState("churned")).toBe("churned");
    expect(storedLifecycleState("dormant")).toBe("dormant");
    expect(LIFECYCLE_STATE_NAMES).toContain("gone_quiet");
  });

  it("returns gone_quiet for the stored churned state in responses", () => {
    expect(publicLifecycleState("churned")).toBe("gone_quiet");
    expect(publicLifecycleState("gone_quiet")).toBe("gone_quiet");
    expect(publicLifecycleState("dormant")).toBe("dormant");
    expect(publicStateCounts({ churned: 2, gone_quiet: 1, engaged: 3 })).toEqual({ gone_quiet: 3, engaged: 3 });
    const row = { lifecycle_state: "churned", plan: "churned", from_state: null };
    expect(withPublicStates(row, ["lifecycle_state", "from_state"])).toEqual({ lifecycle_state: "gone_quiet", plan: "churned", from_state: null });
  });

  it("lifecycle_state conditions match a churned contact by either name", async () => {
    expect(await evaluateAudienceCondition({ lifecycle_state: "gone_quiet" }, ctx("churned"))).toBe(true);
    expect(await evaluateAudienceCondition({ lifecycle_state: "churned" }, ctx("churned"))).toBe(true);
    expect(await evaluateAudienceCondition({ lifecycle_state_not: "gone_quiet" }, ctx("churned"))).toBe(false);
    expect(await evaluateAudienceCondition({ lifecycle_state_not: "gone_quiet" }, ctx("dormant"))).toBe(true);
  });

  it("lifecycle_transition triggers match dormant -> churned by either name", () => {
    expect(matchesLifecycleTransition(flow({ to: "gone_quiet" }), "dormant", "churned")).toBe(true);
    expect(matchesLifecycleTransition(flow({ to: "churned" }), "dormant", "churned")).toBe(true);
    expect(matchesLifecycleTransition(flow({ from: "gone_quiet", to: "resurrected" }), "churned", "resurrected")).toBe(true);
    expect(matchesLifecycleTransition(flow({ to: "gone_quiet" }), "at_risk", "dormant")).toBe(false);
  });

  it("segment triggers accept gone_quiet in lifecycle_states", () => {
    expect(configTriggerSchema.safeParse({ type: "segment", lifecycle_states: ["gone_quiet"] }).success).toBe(true);
    expect(configTriggerSchema.safeParse({ type: "segment", lifecycle_states: ["churned"] }).success).toBe(true);
    expect(configTriggerSchema.safeParse({ type: "segment", lifecycle_states: ["gone"] }).success).toBe(false);
  });

  it("gone_quiet_days is accepted, wins over churned_days, and is checked against dormant_days", () => {
    expect(configLifecycleSchema.safeParse({ gone_quiet_days: 45 }).success).toBe(true);
    expect(configLifecycleSchema.safeParse({ churned_days: 45 }).success).toBe(true);
    expect(configLifecycleSchema.safeParse({ gone_quiet_days: 45, churned_days: 45 }).success).toBe(true);
    expect(configLifecycleSchema.safeParse({ gone_quiet_days: 45, churned_days: 60 }).success).toBe(false);
    const tooSoon = configLifecycleSchema.safeParse({ dormant_days: 30, gone_quiet_days: 30 });
    expect(tooSoon.success).toBe(false);
    expect(JSON.stringify(tooSoon.error?.issues)).toContain("gone_quiet_days must be greater than dormant_days");

    expect(resolveLifecycleConfig({ gone_quiet_days: 45 }).churned_days).toBe(45);
    expect(resolveLifecycleConfig({ churned_days: 60 }).churned_days).toBe(60);
    expect(resolveLifecycleConfig({ gone_quiet_days: 45, churned_days: 60 }).churned_days).toBe(45);
  });
});
