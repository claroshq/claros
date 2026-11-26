/**
 * Lifecycle replay (history import): the state recomputed from an event
 * history matches what live ingest plus the 15-minute scan would reach, and
 * is a fixed point for the scan at `now`.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  isEngagementEvent,
  inactivityThresholdDays,
  replayLifecycle,
  engagementCounters,
  upcomingTimeTransitions,
  resolveLifecycleConfig,
  LIFECYCLE_STATES,
  type LifecycleConfig,
  type LifecycleState,
  type ReplayEvent,
} from "../src/lifecycle/index.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);
const at = (days: number) => new Date(T0 + days * DAY);
const track = (name: string, days: number): ReplayEvent => ({ type: "track", eventName: name, timestamp: at(days) });

const productConfig: LifecycleConfig = resolveLifecycleConfig({
  activation_events: ["activated"],
  engagement_events: ["active_day", "activated"],
  natural_frequency_days: 7,
  at_risk_missed_intervals: 2,
  dormant_days: 30,
  churned_days: 45,
});

describe("inactivityThresholdDays", () => {
  it("is the threshold evaluateTimeTransition uses", () => {
    for (const state of LIFECYCLE_STATES) {
      const days = inactivityThresholdDays(state, productConfig);
      if (days === null) continue;
      const lastSeenAt = at(0);
      expect(evaluateTimeTransition({ currentState: state, lastSeenAt, now: new Date(lastSeenAt.getTime() + days * DAY - 1), config: productConfig })).toBeNull();
      expect(evaluateTimeTransition({ currentState: state, lastSeenAt, now: new Date(lastSeenAt.getTime() + days * DAY), config: productConfig })).not.toBeNull();
    }
  });
});

describe("replayLifecycle", () => {
  it("returns null without events", () => {
    expect(replayLifecycle([], productConfig, at(10))).toBeNull();
  });

  it("walks signup, activation, use and decay at the moments they happen", () => {
    const events: ReplayEvent[] = [
      track("signed_up", 0),
      track("activated", 1),
      track("active_day", 1),
      ...Array.from({ length: 19 }, (_, i) => track("active_day", i + 2)),
    ];
    const r = replayLifecycle(events, productConfig, at(100))!;
    expect(r.state).toBe("churned");
    expect(r.firstSeenAt).toEqual(at(0));
    expect(r.lastSeenAt).toEqual(at(20));
    expect(r.activatedAt).toEqual(at(1));
    expect(r.transitions.map((t) => [t.from, t.to, t.at.getTime(), t.trigger])).toEqual([
      ["signed_up", "activated", at(1).getTime(), "event"],
      ["activated", "engaged", at(1).getTime(), "event"],
      ["engaged", "at_risk", at(34).getTime(), "time"],
      ["at_risk", "dormant", at(50).getTime(), "time"],
      ["dormant", "churned", at(65).getTime(), "time"],
    ]);
  });

  it("orders events by timestamp whatever the input order", () => {
    const events = [track("active_day", 5), track("activated", 2), track("signed_up", 0)];
    const r = replayLifecycle(events, productConfig, at(6))!;
    expect(r.firstSeenAt).toEqual(at(0));
    expect(r.activatedAt).toEqual(at(2));
    expect(r.state).toBe("engaged");
  });

  it("brings a churned contact back as resurrected, promoted to engaged at once", () => {
    const events = [track("activated", 0), track("active_day", 1), track("active_day", 80)];
    const r = replayLifecycle(events, productConfig, at(81))!;
    expect(r.state).toBe("engaged");
    const tail = r.transitions.slice(-2).map((t) => [t.from, t.to, t.at.getTime()]);
    expect(tail).toEqual([
      ["churned", "resurrected", at(80).getTime()],
      ["resurrected", "engaged", at(80).getTime()],
    ]);
  });

  it("keeps signed_up without activation_events, and only activity moves last_seen_at", () => {
    const noActivation = resolveLifecycleConfig({ engagement_events: ["active_day"] });
    const r = replayLifecycle([track("signed_up", 0), track("active_day", 3), track("pricing_viewed", 9)], noActivation, at(60))!;
    expect(r.state).toBe("signed_up");
    expect(r.lastSeenAt).toEqual(at(3));
    expect(r.transitions).toEqual([]);
  });

  it("identify never counts as activity when engagement_events is set", () => {
    const r = replayLifecycle([{ type: "identify", eventName: null, timestamp: at(0) }, { type: "identify", eventName: null, timestamp: at(50) }], productConfig, at(60))!;
    expect(r.lastSeenAt).toEqual(at(0));
    expect(r.state).toBe("signed_up");
  });

  it("leaves no transition for the scan to make at now", () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 300; n++) {
      const events = randomHistory(rnd);
      const now = at(130);
      const r = replayLifecycle(events, productConfig, now)!;
      expect(evaluateTimeTransition({ currentState: r.state, lastSeenAt: r.lastSeenAt, now, config: productConfig })).toBeNull();
    }
  });

  it("matches live ingest plus a scan every 15 minutes", () => {
    const rnd = mulberry32(42);
    for (let n = 0; n < 40; n++) {
      const events = randomHistory(rnd);
      const now = at(130);
      const live = simulateLive(events, productConfig, now);
      const r = replayLifecycle(events, productConfig, now)!;
      expect({ state: r.state, lastSeenAt: r.lastSeenAt, activatedAt: r.activatedAt }).toEqual(live);
    }
  });
});

describe("engagementCounters", () => {
  const acts = [at(1), at(10), at(20), at(28), at(29)].map((d) => d.getTime());
  it("rolls when the reset is older than a bucket (or missing)", () => {
    expect(engagementCounters(acts, null, at(30))).toEqual({ current: 0, prev: 3, resetAt: at(30) });
    expect(engagementCounters(acts, at(2), at(30))).toEqual({ current: 0, prev: 3, resetAt: at(30) });
  });
  it("counts since the reset and the bucket before it", () => {
    expect(engagementCounters(acts, at(20), at(30))).toEqual({ current: 3, prev: 1, resetAt: at(20) });
  });
});

describe("upcomingTimeTransitions", () => {
  it("lists the decay a quiet contact will go through", () => {
    const t = upcomingTimeTransitions("dormant", at(0), productConfig, at(40), at(54));
    expect(t.map((x) => [x.from, x.to, x.at.getTime()])).toEqual([["dormant", "churned", at(45).getTime()]]);
    expect(upcomingTimeTransitions("dormant", at(0), productConfig, at(40), at(44))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live model: ingest each event at its timestamp, scan every 15 minutes.
// ---------------------------------------------------------------------------

function simulateLive(events: ReplayEvent[], config: LifecycleConfig, now: Date) {
  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const TICK = 15 * 60 * 1000;
  let state: LifecycleState = "signed_up";
  let lastSeen = sorted[0]!.timestamp.getTime();
  let activatedAt: Date | null = null;
  const names = new Set<string>();
  let tick = Math.ceil(sorted[0]!.timestamp.getTime() / TICK) * TICK;
  const scanUntil = (t: number) => {
    for (; tick <= t; tick += TICK) {
      const tr = evaluateTimeTransition({ currentState: state, lastSeenAt: new Date(lastSeen), now: new Date(tick), config });
      if (tr) state = tr.to;
    }
  };
  for (const e of sorted) {
    scanUntil(e.timestamp.getTime() - 1);
    const name = e.type === "track" ? e.eventName : null;
    const activity = isEngagementEvent(name, config.engagement_events);
    if (activity) lastSeen = Math.max(lastSeen, e.timestamp.getTime());
    if (name) names.add(name);
    if (state === "engaged" || state === "resurrected") continue;
    let satisfied = false;
    if (state === "signed_up") {
      if (!isActivationRelevantEvent(name, config.activation_events)) continue;
      satisfied = checkActivationSatisfied(names, config.activation_events);
    }
    const tr = evaluateEventTransition({ currentState: state, eventName: name, activationSatisfied: satisfied, countsAsActivity: activity });
    if (tr) {
      state = tr.to;
      if (tr.setActivatedAt && !activatedAt) activatedAt = e.timestamp;
    }
  }
  scanUntil(now.getTime());
  return { state, lastSeenAt: new Date(lastSeen), activatedAt };
}

/** Random history: bursts of use separated by quiet gaps, over ~120 days. */
function randomHistory(rnd: () => number): ReplayEvent[] {
  const out: ReplayEvent[] = [track("signed_up", 0)];
  let d = rnd() * 3;
  const activateAt = rnd() < 0.8 ? rnd() * 20 : null;
  if (activateAt !== null) out.push(track("activated", activateAt));
  while (d < 125) {
    const burst = 1 + Math.floor(rnd() * 10);
    for (let i = 0; i < burst && d < 125; i++, d += 0.5 + rnd() * 2) out.push(track(rnd() < 0.85 ? "active_day" : "pricing_viewed", d));
    d += rnd() < 0.5 ? rnd() * 10 : 10 + rnd() * 60;
  }
  return out;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
