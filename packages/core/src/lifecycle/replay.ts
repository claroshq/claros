/**
 * Lifecycle replay: a contact's lifecycle fields recomputed from its event
 * history, as if every event had been ingested live at its own timestamp
 * and the scan had run continuously (history import, POST /v1/import/lifecycle).
 *
 * Pure. Uses the same decisions as live ingest and the scan:
 * - first event creates the contact in signed_up, first_seen_at and
 *   last_seen_at at its timestamp;
 * - an event that counts as activity (isEngagementEvent) moves last_seen_at;
 * - event-driven transitions as planIngestTransition (activation needs every
 *   activation_event among the contact's track events so far);
 * - time-driven transitions as evaluateTimeTransition, each at the moment its
 *   threshold is crossed (inactivityThresholdDays); resurrected is promoted
 *   to engaged at once (the next scan does that live).
 *
 * The state returned is a fixed point of evaluateTimeTransition at `now`:
 * a scan right after applying it finds no transition to make.
 */
import type { LifecycleConfig, LifecycleState } from "./states.js";
import {
  checkActivationSatisfied,
  evaluateEventTransition,
  inactivityThresholdDays,
  isActivationRelevantEvent,
  isEngagementEvent,
} from "./evaluate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Width of an engagement counter bucket (worker counter rollover, fixed). */
export const ENGAGEMENT_COUNTER_BUCKET_DAYS = 15;

export interface ReplayEvent {
  type: "track" | "identify";
  /** Track event name; null for identify. */
  eventName: string | null;
  timestamp: Date;
}

export interface ReplayTransition {
  from: LifecycleState;
  to: LifecycleState;
  at: Date;
  trigger: "event" | "time";
}

export interface ReplayResult {
  state: LifecycleState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  activatedAt: Date | null;
  transitions: ReplayTransition[];
  /** Engagement counters as the rollover worker would hold them at `now`. */
  counters: { current: number; prev: number; resetAt: Date };
}

interface Cursor {
  state: LifecycleState;
  lastSeenAt: Date;
  /** When the current state was entered. */
  since: Date;
}

/**
 * Apply the time transitions whose threshold falls at or before `until`,
 * in order, and return them (cursor is advanced in place).
 */
function advance(cur: Cursor, config: LifecycleConfig, until: Date): ReplayTransition[] {
  const out: ReplayTransition[] = [];
  for (;;) {
    if (cur.state === "resurrected") {
      out.push({ from: "resurrected", to: "engaged", at: cur.since, trigger: "time" });
      cur.state = "engaged";
      continue;
    }
    const days = inactivityThresholdDays(cur.state, config);
    if (days === null) return out;
    const atMs = cur.lastSeenAt.getTime() + days * DAY_MS;
    if (atMs > until.getTime()) return out;
    const at = new Date(Math.max(atMs, cur.since.getTime()));
    const to = nextByTime(cur.state);
    out.push({ from: cur.state, to, at, trigger: "time" });
    cur.state = to;
    cur.since = at;
  }
}

function nextByTime(state: LifecycleState): LifecycleState {
  switch (state) {
    case "activated":
      return "engaged";
    case "engaged":
      return "at_risk";
    case "at_risk":
      return "dormant";
    case "dormant":
      return "churned";
    default:
      throw new Error(`No time transition out of ${state}`);
  }
}

/**
 * Replay a contact's events (any order; sorted here by timestamp, stable).
 * Returns null for an empty history. `counterResetAt` is the contact's
 * last_counter_reset_at (null when the rollover never ran for it).
 */
export function replayLifecycle(
  events: readonly ReplayEvent[],
  config: LifecycleConfig,
  now: Date,
  counterResetAt: Date | null = null,
): ReplayResult | null {
  if (events.length === 0) return null;
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.timestamp.getTime() - b.e.timestamp.getTime() || a.i - b.i)
    .map((x) => x.e);

  const first = sorted[0]!.timestamp;
  const cur: Cursor = { state: "signed_up", lastSeenAt: first, since: first };
  const transitions: ReplayTransition[] = [];
  const names = new Set<string>();
  const activity: number[] = [];
  let activatedAt: Date | null = null;

  for (const e of sorted) {
    transitions.push(...advance(cur, config, e.timestamp));
    const eventName = e.type === "track" ? e.eventName : null;
    const countsAsActivity = isEngagementEvent(eventName, config.engagement_events);
    if (countsAsActivity) {
      if (e.timestamp.getTime() > cur.lastSeenAt.getTime()) cur.lastSeenAt = e.timestamp;
      activity.push(e.timestamp.getTime());
    }
    if (eventName !== null) names.add(eventName);

    if (cur.state === "engaged" || cur.state === "resurrected") continue;
    let activationSatisfied = false;
    if (cur.state === "signed_up") {
      if (!isActivationRelevantEvent(eventName, config.activation_events)) continue;
      activationSatisfied = checkActivationSatisfied(names, config.activation_events);
    }
    const t = evaluateEventTransition({ currentState: cur.state, eventName, activationSatisfied, countsAsActivity });
    if (t === null) continue;
    transitions.push({ from: t.from, to: t.to, at: e.timestamp, trigger: "event" });
    cur.state = t.to;
    cur.since = e.timestamp;
    if (t.setActivatedAt && activatedAt === null) activatedAt = e.timestamp;
  }
  transitions.push(...advance(cur, config, now));

  return {
    state: cur.state,
    firstSeenAt: first,
    lastSeenAt: cur.lastSeenAt,
    activatedAt,
    transitions,
    counters: engagementCounters(activity, counterResetAt, now),
  };
}

/**
 * The two engagement counter buckets for a list of activity times (ms):
 * with a reset younger than a bucket, current counts since the reset and
 * prev the bucket before it; otherwise the rollover is due, so the counters
 * are rolled here (reset now, prev = the last bucket, current = 0).
 */
export function engagementCounters(
  activityMs: readonly number[],
  resetAt: Date | null,
  now: Date,
): { current: number; prev: number; resetAt: Date } {
  const bucketMs = ENGAGEMENT_COUNTER_BUCKET_DAYS * DAY_MS;
  const nowMs = now.getTime();
  const count = (from: number, to: number) => activityMs.filter((t) => t >= from && t < to).length;
  if (resetAt === null || resetAt.getTime() < nowMs - bucketMs || resetAt.getTime() > nowMs) {
    return { current: 0, prev: count(nowMs - bucketMs, nowMs + 1), resetAt: now };
  }
  const r = resetAt.getTime();
  return { current: count(r, nowMs + 1), prev: count(r - bucketMs, r), resetAt };
}

/**
 * The time transitions a contact in `state` (last seen at `lastSeenAt`)
 * would make between now and `until` if no event arrives (forecast).
 */
export function upcomingTimeTransitions(
  state: LifecycleState,
  lastSeenAt: Date,
  config: LifecycleConfig,
  now: Date,
  until: Date,
): ReplayTransition[] {
  return advance({ state, lastSeenAt, since: now }, config, until);
}
