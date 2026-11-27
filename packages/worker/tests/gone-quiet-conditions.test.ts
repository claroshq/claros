/**
 * gone_quiet (new name of churned) in step and plan-exit conditions: the
 * stored state is still churned during the deprecation window.
 */
import { describe, it, expect } from "vitest";
import { evaluateStepCondition, evaluatePlanExitCondition, type EventChecker } from "../src/condition-evaluator.js";

const events: EventChecker = { hasEventSince: async () => false };
const since = new Date("2026-11-01T00:00:00Z");

describe("gone_quiet in worker conditions", () => {
  it("step conditions treat gone_quiet as churned", async () => {
    const churned = { lifecycleState: "churned" };
    expect((await evaluateStepCondition({ lifecycle_state: "gone_quiet" }, churned, events, since)).outcome).toBe("pass");
    expect((await evaluateStepCondition({ lifecycle_state_not: "gone_quiet" }, churned, events, since)).outcome).toBe("fail");
    expect((await evaluateStepCondition({ lifecycle_state: "gone_quiet" }, { lifecycleState: "dormant" }, events, since)).outcome).toBe("fail");
  });

  it("plan exits on lifecycle_state_change to gone_quiet fire for a churned contact", async () => {
    const r = await evaluatePlanExitCondition({ lifecycle_state_change: { to: "gone_quiet" } }, { lifecycleState: "churned" }, events, since);
    expect(r.outcome).toBe("pass");
  });
});
