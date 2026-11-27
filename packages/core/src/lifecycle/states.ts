/**
 * Lifecycle state machine: states, valid transitions, and configuration types.
 *
 * This is the single source of truth for which transitions are legal.
 * An attempt to transition outside this table is a bug, not a no-op.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATES = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * `gone_quiet` is the new name of the `churned` state (no product activity
 * for churned_days; says nothing about billing, a paying customer can be in
 * it). The database stores `churned` (no data migration, DECISIONS.md
 * 2026-11-27); `gone_quiet` is accepted wherever a state is given as input
 * (flow triggers, conditions, exits, filters) and means the same state.
 * The API returns `gone_quiet` (publicLifecycleState at its boundary).
 */
export const GONE_QUIET = "gone_quiet" as const;

/** Every state name accepted as input: the seven states plus `gone_quiet`. */
export const LIFECYCLE_STATE_NAMES = [...LIFECYCLE_STATES, GONE_QUIET] as const;

/**
 * The stored lifecycle_state value for a state name given as input
 * (`gone_quiet` -> `churned`); any other string is returned unchanged.
 */
export function storedLifecycleState(name: string): string {
  return name === GONE_QUIET ? "churned" : name;
}

/**
 * The name the API returns for a stored lifecycle state
 * (`churned` -> `gone_quiet`); any other string is returned unchanged.
 */
export function publicLifecycleState(stored: string): string {
  return stored === "churned" ? GONE_QUIET : stored;
}

/**
 * A copy of a response row with the stored state at each named field
 * replaced by its public name (fields that are absent or not strings are
 * left as they are).
 */
export function withPublicStates<T extends object>(row: T, fields: readonly string[]): T {
  const out = { ...row } as Record<string, unknown>;
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") out[f] = publicLifecycleState(v);
  }
  return out as T;
}

/** A count map keyed by stored state names, keyed by public names. */
export function publicStateCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [state, n] of Object.entries(counts)) {
    const name = publicLifecycleState(state);
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transition trigger types
// ---------------------------------------------------------------------------

/**
 * How a transition is triggered:
 * - event: an inbound event (track/identify) causes the transition
 * - time: absence of events over a threshold causes the transition (scan worker)
 */
export type TransitionTrigger = "event" | "time";

// ---------------------------------------------------------------------------
// Valid transitions (exhaustive - anything not listed is illegal)
// ---------------------------------------------------------------------------

export interface TransitionRule {
  from: LifecycleState;
  to: LifecycleState;
  trigger: TransitionTrigger;
  description: string;
}

/**
 * The complete set of legal lifecycle transitions.
 * Encoded explicitly per the spec (Section 4). If a transition is not in this
 * list, it is a bug in the caller, not a silent no-op.
 */
export const VALID_TRANSITIONS: readonly TransitionRule[] = [
  {
    from: "signed_up",
    to: "activated",
    trigger: "event",
    description: "All activation_events satisfied",
  },
  {
    from: "activated",
    to: "engaged",
    trigger: "event",
    description: "Any activity after activation",
  },
  {
    from: "activated",
    to: "engaged",
    trigger: "time",
    description:
      "Stale activated contact promoted to engaged after natural_frequency_days so decay path begins",
  },
  {
    from: "engaged",
    to: "at_risk",
    trigger: "time",
    description: "No activity for at_risk_missed_intervals x natural_frequency_days",
  },
  {
    from: "at_risk",
    to: "engaged",
    trigger: "event",
    description: "Any activity while at_risk",
  },
  {
    from: "at_risk",
    to: "dormant",
    trigger: "time",
    description: "No activity for dormant_days",
  },
  {
    from: "dormant",
    to: "engaged",
    trigger: "event",
    description: "Any activity while dormant",
  },
  {
    from: "dormant",
    to: "churned",
    trigger: "time",
    description: "No activity for churned_days",
  },
  {
    from: "churned",
    to: "resurrected",
    trigger: "event",
    description: "Any activity after churned",
  },
  {
    from: "resurrected",
    to: "engaged",
    trigger: "time",
    description: "Scan promotes resurrected to engaged once activity is confirmed",
  },
] as const;

/**
 * Pre-computed lookup: for a given (from, trigger) pair, what are the valid
 * target states? Used by the evaluator to validate transitions and by tests
 * to confirm exhaustiveness.
 */
export const VALID_TRANSITION_MAP: ReadonlyMap<
  `${LifecycleState}:${TransitionTrigger}`,
  readonly LifecycleState[]
> = (() => {
  const map = new Map<`${LifecycleState}:${TransitionTrigger}`, LifecycleState[]>();
  for (const rule of VALID_TRANSITIONS) {
    const key = `${rule.from}:${rule.trigger}` as const;
    const existing = map.get(key) ?? [];
    existing.push(rule.to);
    map.set(key, existing);
  }
  return map;
})();

/**
 * Assert that a proposed transition is legal. Throws if not.
 * This is NOT a "should we transition" check - it is a "is this transition
 * even possible in the state machine" check. Call this before writing.
 */
export function assertValidTransition(
  from: LifecycleState,
  to: LifecycleState,
  trigger: TransitionTrigger,
): void {
  const key = `${from}:${trigger}` as const;
  const validTargets = VALID_TRANSITION_MAP.get(key);
  if (!validTargets || !validTargets.includes(to)) {
    throw new Error(
      `Invalid lifecycle transition: ${from} -> ${to} (trigger: ${trigger}). ` +
        `Valid targets from ${from} with trigger ${trigger}: ${validTargets?.join(", ") ?? "none"}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle configuration (per-tenant, stored in tenants.settings)
// ---------------------------------------------------------------------------

/**
 * Lifecycle thresholds. Stored in tenants.settings.lifecycle.
 * All fields optional - defaults applied from constants.ts.
 */
export interface LifecycleConfig {
  /** Events that must ALL occur for signed_up -> activated. Empty = no auto-activation. */
  activation_events: string[];
  /**
   * Track event names that count as activity (bump last_seen_at and the
   * engagement counters, drive the activity-based transitions). Empty = every
   * track and identify counts. When set, identify never counts.
   */
  engagement_events: string[];
  /** Days from first_seen_at within which activation must happen (informational). */
  activation_window_days: number;
  /** Expected activity interval in days. */
  natural_frequency_days: number;
  /** Multiplier: at_risk after this many missed intervals. */
  at_risk_missed_intervals: number;
  /** Days of inactivity before dormant (from last_seen_at). */
  dormant_days: number;
  /** Days of inactivity before churned, now called gone_quiet (from last_seen_at). */
  churned_days: number;
  /** Window for engagement depth computation (days). */
  engagement_depth_window_days: number;
  /** Top N percentile = power user. */
  power_user_percentile: number;
}
