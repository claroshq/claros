/**
 * Unit tests for the lifecycle state machine (pure logic, no I/O).
 *
 * Tests:
 * - Valid transition table exhaustiveness
 * - Event-driven transitions (evaluateEventTransition)
 * - Time-driven transitions (evaluateTimeTransition)
 * - Activation check logic
 * - Invalid transitions throw
 * - Config resolution
 */
import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  VALID_TRANSITION_MAP,
  assertValidTransition,
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  isEngagementEvent,
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
  type LifecycleState,
  type LifecycleConfig,
} from "../src/lifecycle/index.js";

// ---------------------------------------------------------------------------
// assertValidTransition
// ---------------------------------------------------------------------------

describe("assertValidTransition", () => {
  it("accepts all entries in VALID_TRANSITIONS", () => {
    for (const rule of VALID_TRANSITIONS) {
      expect(() =>
        assertValidTransition(rule.from, rule.to, rule.trigger),
      ).not.toThrow();
    }
  });

  it("throws on invalid transitions", () => {
    // engaged -> signed_up is never valid
    expect(() => assertValidTransition("engaged", "signed_up", "event")).toThrow(
      /Invalid lifecycle transition/,
    );
    // churned -> engaged directly is not valid (must go through resurrected)
    expect(() => assertValidTransition("churned", "engaged", "event")).toThrow(
      /Invalid lifecycle transition/,
    );
    // signed_up -> at_risk is not valid
    expect(() => assertValidTransition("signed_up", "at_risk", "time")).toThrow(
      /Invalid lifecycle transition/,
    );
  });

  it("throws when trigger type is wrong for a valid from->to pair", () => {
    // signed_up -> activated is event-driven, not time-driven
    expect(() =>
      assertValidTransition("signed_up", "activated", "time"),
    ).toThrow(/Invalid lifecycle transition/);
    // engaged -> at_risk is time-driven, not event-driven
    expect(() =>
      assertValidTransition("engaged", "at_risk", "event"),
    ).toThrow(/Invalid lifecycle transition/);
  });
});

// ---------------------------------------------------------------------------
// VALID_TRANSITION_MAP completeness
// ---------------------------------------------------------------------------

describe("VALID_TRANSITION_MAP", () => {
  it("every state has at least one exit transition defined in VALID_TRANSITIONS", () => {
    // churned has only event-driven exit (-> resurrected)
    // signed_up has only event-driven exit (-> activated)
    // resurrected has only time-driven exit (-> engaged)
    for (const state of LIFECYCLE_STATES) {
      const hasEventExit = VALID_TRANSITION_MAP.has(`${state}:event`);
      const hasTimeExit = VALID_TRANSITION_MAP.has(`${state}:time`);
      // Every state must have at least one exit path
      expect(hasEventExit || hasTimeExit).toBe(true);
    }
  });

  it("contains exactly the transitions from VALID_TRANSITIONS", () => {
    let count = 0;
    for (const targets of VALID_TRANSITION_MAP.values()) {
      count += targets.length;
    }
    expect(count).toBe(VALID_TRANSITIONS.length);
  });
});

// ---------------------------------------------------------------------------
// evaluateEventTransition
// ---------------------------------------------------------------------------

describe("evaluateEventTransition", () => {
  describe("signed_up state", () => {
    it("returns null when activationSatisfied is false", () => {
      const result = evaluateEventTransition({
        currentState: "signed_up",
        eventName: "project_created",
        activationSatisfied: false,
      });
      expect(result).toBeNull();
    });

    it("returns signed_up -> activated when activationSatisfied is true", () => {
      const result = evaluateEventTransition({
        currentState: "signed_up",
        eventName: "project_created",
        activationSatisfied: true,
      });
      expect(result).toEqual({
        from: "signed_up",
        to: "activated",
        setActivatedAt: true,
      });
    });

    it("setActivatedAt is true on signed_up -> activated", () => {
      const result = evaluateEventTransition({
        currentState: "signed_up",
        eventName: "project_created",
        activationSatisfied: true,
      });
      expect(result!.setActivatedAt).toBe(true);
    });
  });

  describe("activated state", () => {
    it("transitions to engaged on any activity", () => {
      const result = evaluateEventTransition({
        currentState: "activated",
        eventName: "page_viewed",
        activationSatisfied: false,
      });
      expect(result).toEqual({
        from: "activated",
        to: "engaged",
        setActivatedAt: false,
      });
    });

    it("transitions to engaged even with null eventName (identify)", () => {
      const result = evaluateEventTransition({
        currentState: "activated",
        eventName: null,
        activationSatisfied: false,
      });
      expect(result).toEqual({
        from: "activated",
        to: "engaged",
        setActivatedAt: false,
      });
    });
  });

  describe("at_risk state", () => {
    it("transitions to engaged on any activity", () => {
      const result = evaluateEventTransition({
        currentState: "at_risk",
        eventName: "login",
        activationSatisfied: false,
      });
      expect(result).toEqual({
        from: "at_risk",
        to: "engaged",
        setActivatedAt: false,
      });
    });
  });

  describe("dormant state", () => {
    it("transitions to engaged on any activity", () => {
      const result = evaluateEventTransition({
        currentState: "dormant",
        eventName: "login",
        activationSatisfied: false,
      });
      expect(result).toEqual({
        from: "dormant",
        to: "engaged",
        setActivatedAt: false,
      });
    });
  });

  describe("churned state", () => {
    it("transitions to resurrected on any activity", () => {
      const result = evaluateEventTransition({
        currentState: "churned",
        eventName: "page_viewed",
        activationSatisfied: false,
      });
      expect(result).toEqual({
        from: "churned",
        to: "resurrected",
        setActivatedAt: false,
      });
    });
  });

  describe("engaged state", () => {
    it("returns null (no event-driven transition out of engaged)", () => {
      const result = evaluateEventTransition({
        currentState: "engaged",
        eventName: "anything",
        activationSatisfied: false,
      });
      expect(result).toBeNull();
    });
  });

  describe("resurrected state", () => {
    it("returns null (scan promotes to engaged, not events)", () => {
      const result = evaluateEventTransition({
        currentState: "resurrected",
        eventName: "anything",
        activationSatisfied: false,
      });
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateTimeTransition
// ---------------------------------------------------------------------------

describe("evaluateTimeTransition", () => {
  const config: LifecycleConfig = {
    activation_events: ["project_created"],
    activation_window_days: 10,
    natural_frequency_days: 7,
    at_risk_missed_intervals: 2,
    dormant_days: 30,
    churned_days: 90,
    engagement_depth_window_days: 30,
    power_user_percentile: 0.1,
  };

  function daysAgo(days: number): Date {
    const d = new Date("2026-07-20T12:00:00Z");
    d.setDate(d.getDate() - days);
    return d;
  }

  const now = new Date("2026-07-20T12:00:00Z");

  describe("engaged state", () => {
    it("transitions to at_risk after at_risk_missed_intervals x natural_frequency_days", () => {
      // 2 * 7 = 14 days threshold
      const result = evaluateTimeTransition({
        currentState: "engaged",
        lastSeenAt: daysAgo(14),
        now,
        config,
      });
      expect(result).toEqual({
        from: "engaged",
        to: "at_risk",
        setActivatedAt: false,
      });
    });

    it("does not transition before threshold", () => {
      const result = evaluateTimeTransition({
        currentState: "engaged",
        lastSeenAt: daysAgo(13),
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });

  describe("at_risk state", () => {
    it("transitions to dormant after dormant_days", () => {
      const result = evaluateTimeTransition({
        currentState: "at_risk",
        lastSeenAt: daysAgo(30),
        now,
        config,
      });
      expect(result).toEqual({
        from: "at_risk",
        to: "dormant",
        setActivatedAt: false,
      });
    });

    it("does not transition before dormant_days", () => {
      const result = evaluateTimeTransition({
        currentState: "at_risk",
        lastSeenAt: daysAgo(29),
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });

  describe("dormant state", () => {
    it("transitions to churned after churned_days", () => {
      const result = evaluateTimeTransition({
        currentState: "dormant",
        lastSeenAt: daysAgo(90),
        now,
        config,
      });
      expect(result).toEqual({
        from: "dormant",
        to: "churned",
        setActivatedAt: false,
      });
    });

    it("does not transition before churned_days", () => {
      const result = evaluateTimeTransition({
        currentState: "dormant",
        lastSeenAt: daysAgo(89),
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });

  describe("resurrected state", () => {
    it("transitions to engaged when last activity is within natural_frequency_days", () => {
      const result = evaluateTimeTransition({
        currentState: "resurrected",
        lastSeenAt: daysAgo(3), // 3 days ago, within 7-day natural frequency
        now,
        config,
      });
      expect(result).toEqual({
        from: "resurrected",
        to: "engaged",
        setActivatedAt: false,
      });
    });

    it("does not transition when last activity is too old", () => {
      const result = evaluateTimeTransition({
        currentState: "resurrected",
        lastSeenAt: daysAgo(8), // 8 days ago, outside 7-day natural frequency
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });

  describe("activated state", () => {
    it("transitions to engaged when stale (daysSinceLastSeen >= natural_frequency_days)", () => {
      const result = evaluateTimeTransition({
        currentState: "activated",
        lastSeenAt: daysAgo(7), // exactly at natural_frequency_days threshold
        now,
        config,
      });
      expect(result).toEqual({
        from: "activated",
        to: "engaged",
        setActivatedAt: false,
      });
    });

    it("transitions to engaged when very stale", () => {
      const result = evaluateTimeTransition({
        currentState: "activated",
        lastSeenAt: daysAgo(100),
        now,
        config,
      });
      expect(result).toEqual({
        from: "activated",
        to: "engaged",
        setActivatedAt: false,
      });
    });

    it("does not transition when last activity is recent", () => {
      const result = evaluateTimeTransition({
        currentState: "activated",
        lastSeenAt: daysAgo(6), // 6 days ago, within 7-day natural frequency
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });

  describe("states with no time-driven transitions", () => {
    it("signed_up returns null", () => {
      const result = evaluateTimeTransition({
        currentState: "signed_up",
        lastSeenAt: daysAgo(100),
        now,
        config,
      });
      expect(result).toBeNull();
    });

    it("churned returns null", () => {
      const result = evaluateTimeTransition({
        currentState: "churned",
        lastSeenAt: daysAgo(365),
        now,
        config,
      });
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// checkActivationSatisfied
// ---------------------------------------------------------------------------

describe("checkActivationSatisfied", () => {
  it("returns false when activation_events is empty", () => {
    const result = checkActivationSatisfied(
      new Set(["project_created", "invite_sent"]),
      [],
    );
    expect(result).toBe(false);
  });

  it("returns true when all activation_events are present", () => {
    const result = checkActivationSatisfied(
      new Set(["project_created", "invite_sent", "page_viewed"]),
      ["project_created", "invite_sent"],
    );
    expect(result).toBe(true);
  });

  it("returns false when some activation_events are missing", () => {
    const result = checkActivationSatisfied(
      new Set(["project_created"]),
      ["project_created", "invite_sent"],
    );
    expect(result).toBe(false);
  });

  it("returns true for single activation event", () => {
    const result = checkActivationSatisfied(
      new Set(["project_created"]),
      ["project_created"],
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isActivationRelevantEvent
// ---------------------------------------------------------------------------

describe("isActivationRelevantEvent", () => {
  it("returns false for null eventName", () => {
    expect(isActivationRelevantEvent(null, ["project_created"])).toBe(false);
  });

  it("returns false for empty activation_events", () => {
    expect(isActivationRelevantEvent("project_created", [])).toBe(false);
  });

  it("returns false when event is not in activation_events", () => {
    expect(
      isActivationRelevantEvent("page_viewed", ["project_created", "invite_sent"]),
    ).toBe(false);
  });

  it("returns true when event is in activation_events", () => {
    expect(
      isActivationRelevantEvent("project_created", ["project_created", "invite_sent"]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveLifecycleConfig
// ---------------------------------------------------------------------------

describe("resolveLifecycleConfig", () => {
  it("returns defaults when no overrides", () => {
    const config = resolveLifecycleConfig(null);
    expect(config).toEqual(LIFECYCLE_DEFAULTS);
  });

  it("returns defaults for undefined", () => {
    const config = resolveLifecycleConfig(undefined);
    expect(config).toEqual(LIFECYCLE_DEFAULTS);
  });

  it("merges partial overrides with defaults", () => {
    const config = resolveLifecycleConfig({
      dormant_days: 45,
      activation_events: ["signup_completed"],
    });
    expect(config.dormant_days).toBe(45);
    expect(config.activation_events).toEqual(["signup_completed"]);
    // Others should be default
    expect(config.natural_frequency_days).toBe(7);
    expect(config.churned_days).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// settings.lifecycle.engagement_events
// ---------------------------------------------------------------------------

describe("isEngagementEvent", () => {
  it("counts every track and identify when the list is empty", () => {
    expect(isEngagementEvent("anything", [])).toBe(true);
    expect(isEngagementEvent(null, [])).toBe(true);
  });

  it("counts only listed track events when the list is set; identify never counts", () => {
    expect(isEngagementEvent("project_created", ["project_created"])).toBe(true);
    expect(isEngagementEvent("email_opened", ["project_created"])).toBe(false);
    expect(isEngagementEvent(null, ["project_created"])).toBe(false);
  });
});

describe("evaluateEventTransition with countsAsActivity", () => {
  const states: LifecycleState[] = ["activated", "at_risk", "dormant", "churned"];

  it("defaults to counting as activity (today's behaviour)", () => {
    for (const currentState of states) {
      expect(evaluateEventTransition({ currentState, eventName: "x", activationSatisfied: false })).not.toBeNull();
    }
  });

  it("drives no activity-based transition when the event does not count", () => {
    for (const currentState of [...states, "engaged", "resurrected"] as LifecycleState[]) {
      expect(
        evaluateEventTransition({ currentState, eventName: "x", activationSatisfied: false, countsAsActivity: false }),
      ).toBeNull();
    }
  });

  it("still activates a signed_up contact (activation is independent of the list)", () => {
    expect(
      evaluateEventTransition({ currentState: "signed_up", eventName: "x", activationSatisfied: true, countsAsActivity: false }),
    ).toEqual({ from: "signed_up", to: "activated", setActivatedAt: true });
  });
});

describe("resolveLifecycleConfig engagement_events", () => {
  it("defaults to an empty list and keeps an override", () => {
    expect(resolveLifecycleConfig(null).engagement_events).toEqual([]);
    expect(resolveLifecycleConfig({ engagement_events: ["a"] }).engagement_events).toEqual(["a"]);
  });
});
