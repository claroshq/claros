/**
 * Lifecycle state machine evaluation: pure functions.
 *
 * These functions compute what transition (if any) should happen given
 * the current state, an event, and configuration. They have no I/O -
 * the caller is responsible for reading state and writing transitions.
 */
import type { LifecycleState, LifecycleConfig } from "./states.js";
import { assertValidTransition } from "./states.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A transition that should be applied. The caller writes this to the DB
 * (CAS on contacts.lifecycle_state + insert into lifecycle_transitions).
 */
export interface Transition {
  from: LifecycleState;
  to: LifecycleState;
  /** Whether activated_at should be set (only on signed_up -> activated). */
  setActivatedAt: boolean;
}

/**
 * Inputs for event-driven transition evaluation.
 */
export interface EventTransitionInput {
  /** Contact's current lifecycle_state. */
  currentState: LifecycleState;
  /** The event name from the track call (null for identify events). */
  eventName: string | null;
  /** Whether all activation_events have been satisfied (pre-computed by caller). */
  activationSatisfied: boolean;
  /**
   * Whether the event counts as activity (isEngagementEvent). Default true.
   * When false, only signed_up -> activated can happen: activation is
   * evaluated independently of settings.lifecycle.engagement_events.
   */
  countsAsActivity?: boolean;
}

/**
 * Inputs for time-driven transition evaluation (called by scan worker).
 */
export interface TimeTransitionInput {
  /** Contact's current lifecycle_state. */
  currentState: LifecycleState;
  /** Contact's last_seen_at timestamp. */
  lastSeenAt: Date;
  /** Current time. */
  now: Date;
  /** Resolved lifecycle config for the tenant. */
  config: LifecycleConfig;
}

// ---------------------------------------------------------------------------
// Event-driven evaluation (called on ingest)
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an incoming event triggers a lifecycle transition.
 *
 * Returns the transition to apply, or null if no transition occurs.
 * Throws on invalid/impossible transitions (bug in caller or state corruption).
 *
 * Short-circuits:
 * - engaged contacts: no event-driven transition out of engaged (only time-driven)
 * - signed_up contacts: only transitions if activationSatisfied is true
 * - resurrected contacts: no event-driven transition (scan promotes to engaged)
 * - an event that does not count as activity (countsAsActivity false) drives
 *   no activity-based transition (activated/at_risk/dormant -> engaged,
 *   churned -> resurrected)
 */
export function evaluateEventTransition(
  input: EventTransitionInput,
): Transition | null {
  const { currentState, activationSatisfied } = input;
  if (input.countsAsActivity === false && currentState !== "signed_up") return null;

  switch (currentState) {
    case "signed_up": {
      if (!activationSatisfied) return null;
      assertValidTransition("signed_up", "activated", "event");
      return { from: "signed_up", to: "activated", setActivatedAt: true };
    }

    case "activated": {
      // Any activity after activation moves to engaged.
      assertValidTransition("activated", "engaged", "event");
      return { from: "activated", to: "engaged", setActivatedAt: false };
    }

    case "at_risk": {
      // Any activity while at_risk re-engages.
      assertValidTransition("at_risk", "engaged", "event");
      return { from: "at_risk", to: "engaged", setActivatedAt: false };
    }

    case "dormant": {
      // Any activity while dormant re-engages.
      assertValidTransition("dormant", "engaged", "event");
      return { from: "dormant", to: "engaged", setActivatedAt: false };
    }

    case "churned": {
      // Any activity after churned = resurrected.
      assertValidTransition("churned", "resurrected", "event");
      return { from: "churned", to: "resurrected", setActivatedAt: false };
    }

    case "engaged":
      // No event-driven transition out of engaged. Time-driven only.
      return null;

    case "resurrected":
      // Resurrected contacts wait for scan to promote to engaged.
      // No event-driven transition.
      return null;

    default: {
      // Exhaustive check: if a new state is added, this errors at compile time.
      const _exhaustive: never = currentState;
      throw new Error(`Unknown lifecycle state: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Time-driven evaluation (called by scan worker - task 12)
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a contact should transition due to inactivity.
 *
 * Returns the transition to apply, or null if no transition occurs.
 * Called by the scan worker on a periodic schedule.
 */
export function evaluateTimeTransition(
  input: TimeTransitionInput,
): Transition | null {
  const { currentState, lastSeenAt, now, config } = input;
  const daysSinceLastSeen = daysBetween(lastSeenAt, now);

  switch (currentState) {
    case "engaged": {
      const atRiskThreshold =
        config.at_risk_missed_intervals * config.natural_frequency_days;
      if (daysSinceLastSeen >= atRiskThreshold) {
        assertValidTransition("engaged", "at_risk", "time");
        return { from: "engaged", to: "at_risk", setActivatedAt: false };
      }
      return null;
    }

    case "at_risk": {
      if (daysSinceLastSeen >= config.dormant_days) {
        assertValidTransition("at_risk", "dormant", "time");
        return { from: "at_risk", to: "dormant", setActivatedAt: false };
      }
      return null;
    }

    case "dormant": {
      if (daysSinceLastSeen >= config.churned_days) {
        assertValidTransition("dormant", "churned", "time");
        return { from: "dormant", to: "churned", setActivatedAt: false };
      }
      return null;
    }

    case "resurrected": {
      // Scan promotes resurrected to engaged. Any recent activity
      // (which must exist - the contact entered resurrected via an event)
      // satisfies this. The natural_frequency_days threshold applies.
      if (daysSinceLastSeen < config.natural_frequency_days) {
        assertValidTransition("resurrected", "engaged", "time");
        return { from: "resurrected", to: "engaged", setActivatedAt: false };
      }
      return null;
    }

    case "activated": {
      // [impl] Stale activated contacts are promoted to engaged so they enter
      // the normal decay path (engaged -> at_risk -> dormant -> churned).
      // Without this, a contact that activates then goes silent sits in
      // activated forever. Uses natural_frequency_days as the staleness threshold.
      if (daysSinceLastSeen >= config.natural_frequency_days) {
        assertValidTransition("activated", "engaged", "time");
        return { from: "activated", to: "engaged", setActivatedAt: false };
      }
      return null;
    }

    case "signed_up":
    case "churned":
      // No time-driven transitions out of these states.
      // signed_up -> activated is event-driven (activation_events).
      // churned is a terminal state until an event arrives.
      return null;

    default: {
      const _exhaustive: never = currentState;
      throw new Error(`Unknown lifecycle state: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Activation check helper
// ---------------------------------------------------------------------------

/**
 * Determine if all activation_events have been satisfied.
 *
 * Pure function: caller provides the set of distinct event names the contact
 * has produced. This function checks whether that set is a superset of the
 * configured activation_events.
 *
 * Short-circuits:
 * - Returns false if activation_events is empty (no auto-activation configured)
 * - Returns false if the triggering event is not in activation_events
 */
export function checkActivationSatisfied(
  /** Distinct event names this contact has ever produced (from events table). */
  contactEventNames: ReadonlySet<string>,
  /** The tenant's configured activation events (all must be present). */
  activationEvents: readonly string[],
): boolean {
  if (activationEvents.length === 0) return false;
  for (const required of activationEvents) {
    if (!contactEventNames.has(required)) return false;
  }
  return true;
}

/**
 * Quick pre-check: is the current event even relevant to activation?
 * If not, we can skip the DB query for the contact's event history.
 */
export function isActivationRelevantEvent(
  eventName: string | null,
  activationEvents: readonly string[],
): boolean {
  if (eventName === null) return false;
  if (activationEvents.length === 0) return false;
  return activationEvents.includes(eventName);
}

// ---------------------------------------------------------------------------
// Engagement events
// ---------------------------------------------------------------------------

/**
 * Whether an ingested event counts as activity: bumps last_seen_at and the
 * engagement counters and may drive the activity-based transitions.
 *
 * - engagementEvents empty (settings.lifecycle.engagement_events unset or
 *   []): every track and identify counts (eventName null = identify).
 * - set: only track events whose name is in the list count; identify never
 *   counts.
 */
export function isEngagementEvent(
  eventName: string | null,
  engagementEvents: readonly string[],
): boolean {
  if (engagementEvents.length === 0) return true;
  if (eventName === null) return false;
  return engagementEvents.includes(eventName);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Days between two dates (fractional, always non-negative).
 */
function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}
