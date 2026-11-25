/**
 * Engagement depth computation: pure functions.
 *
 * Assigns one of four depth buckets to a contact based on their event count
 * within the engagement_depth_window_days window.
 *
 * Bucket boundaries (see CLAROS_HANDOFF_V2.md §4 [impl] note for derivation):
 *
 *   power   - event_count >= power_cutoff, AND cohort is large enough for the
 *             percentile to be meaningful (cohort >= floor(1/power_user_percentile))
 *   regular - event_count >= ceil(window_days / natural_frequency_days)
 *   casual  - event_count >= 3 (but below regular threshold)
 *   minimal - event_count 1 or 2
 *
 * The power_cutoff is NOT computed here (it requires the full cohort distribution
 * and lives in the SQL query). This module handles the per-contact assignment
 * given the pre-computed cutoff.
 */
import type { LifecycleConfig } from "./states.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;
export type EngagementDepth = (typeof ENGAGEMENT_DEPTHS)[number];

/**
 * Parameters for assigning a depth bucket to a single contact.
 */
export interface DepthAssignmentInput {
  /** Number of events the contact fired within the window. */
  eventCount: number;
  /**
   * Pre-computed power cutoff for this tenant cohort (from percentile_cont).
   * null means the power bucket is suppressed (cohort below minimum floor).
   */
  powerCutoff: number | null;
  /**
   * Pre-computed regular threshold: ceil(window_days / natural_frequency_days).
   * Contacts at or above this count have fired at least once per natural-frequency
   * period on average within the window.
   */
  regularThreshold: number;
}

// ---------------------------------------------------------------------------
// Configuration helpers (called once per tenant before the per-contact loop)
// ---------------------------------------------------------------------------

/**
 * Compute the minimum cohort size below which the power bucket is suppressed.
 *
 * floor(1 / power_user_percentile): at 0.1, this is 10. Below 10 engaged contacts,
 * the top-10% percentile is too unstable to be meaningful.
 */
export function computeMinCohortSize(config: LifecycleConfig): number {
  return Math.floor(1 / config.power_user_percentile);
}

/**
 * Compute the regular threshold: the minimum event count for a contact to
 * be considered "regular" (firing at or above natural frequency on average).
 *
 * ceil(engagement_depth_window_days / natural_frequency_days).
 * With defaults (30 days window, 7 days natural frequency): ceil(30/7) = 5.
 */
export function computeRegularThreshold(config: LifecycleConfig): number {
  return Math.ceil(
    config.engagement_depth_window_days / config.natural_frequency_days,
  );
}

// ---------------------------------------------------------------------------
// Per-contact assignment
// ---------------------------------------------------------------------------

/**
 * Assign an engagement depth bucket to a single contact.
 *
 * Returns null if eventCount is 0: zero events in the window is not a
 * depth classification - it is absence of activity. The caller should skip
 * updating the contact's depth column in that case.
 *
 * The power_cutoff parameter carries the small-cohort floor decision:
 * - If null, the power bucket is suppressed regardless of eventCount.
 * - If set, power requires eventCount >= powerCutoff.
 */
export function assignEngagementDepth(
  input: DepthAssignmentInput,
): EngagementDepth | null {
  const { eventCount, powerCutoff, regularThreshold } = input;

  if (eventCount <= 0) return null;

  if (powerCutoff !== null && eventCount >= powerCutoff) {
    return "power";
  }

  if (eventCount >= regularThreshold) {
    return "regular";
  }

  if (eventCount >= 3) {
    return "casual";
  }

  // 1 or 2 events
  return "minimal";
}
