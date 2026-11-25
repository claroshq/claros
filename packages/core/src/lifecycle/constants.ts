/**
 * Default lifecycle thresholds from the spec (Appendix B).
 *
 * These are applied when a tenant has no overrides in settings.lifecycle.
 * Business model templates (task 25) will provide different defaults.
 */
import type { LifecycleConfig } from "./states.js";

export const LIFECYCLE_DEFAULTS: Readonly<LifecycleConfig> = {
  activation_events: [],
  engagement_events: [],
  activation_window_days: 10,
  natural_frequency_days: 7,
  at_risk_missed_intervals: 2,
  dormant_days: 30,
  churned_days: 90,
  engagement_depth_window_days: 30,
  power_user_percentile: 0.1,
};

/**
 * Merge partial tenant overrides with defaults.
 * Only known keys are accepted; unknown keys are ignored.
 */
export function resolveLifecycleConfig(
  overrides?: Partial<LifecycleConfig> | null,
): LifecycleConfig {
  if (!overrides) return { ...LIFECYCLE_DEFAULTS };
  return {
    activation_events:
      overrides.activation_events ?? LIFECYCLE_DEFAULTS.activation_events,
    engagement_events:
      overrides.engagement_events ?? LIFECYCLE_DEFAULTS.engagement_events,
    activation_window_days:
      overrides.activation_window_days ?? LIFECYCLE_DEFAULTS.activation_window_days,
    natural_frequency_days:
      overrides.natural_frequency_days ?? LIFECYCLE_DEFAULTS.natural_frequency_days,
    at_risk_missed_intervals:
      overrides.at_risk_missed_intervals ?? LIFECYCLE_DEFAULTS.at_risk_missed_intervals,
    dormant_days: overrides.dormant_days ?? LIFECYCLE_DEFAULTS.dormant_days,
    churned_days: overrides.churned_days ?? LIFECYCLE_DEFAULTS.churned_days,
    engagement_depth_window_days:
      overrides.engagement_depth_window_days ??
      LIFECYCLE_DEFAULTS.engagement_depth_window_days,
    power_user_percentile:
      overrides.power_user_percentile ?? LIFECYCLE_DEFAULTS.power_user_percentile,
  };
}
