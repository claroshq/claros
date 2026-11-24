/**
 * Throttle module - pure business logic for send throttling.
 *
 * Three layers evaluated in order:
 *   L1: Suppression (hard block, never bypassed)
 *   L2: Frequency cap (per-contact rate limiting)
 *   L3: Send window (timezone-aware timing)
 */
export {
  THROTTLE_DEFAULTS,
  resolveThrottleConfig,
  throttleConfigSchema,
  type ThrottleConfig,
} from "./defaults.js";

export {
  evaluateThrottleGate,
  resolveTimezone,
  isValidTimezone,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "./gate.js";
