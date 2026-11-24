/**
 * Lifecycle state machine - public API.
 */
export {
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  VALID_TRANSITION_MAP,
  assertValidTransition,
  type LifecycleState,
  type TransitionTrigger,
  type TransitionRule,
  type LifecycleConfig,
} from "./states.js";

export {
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  type Transition,
  type EventTransitionInput,
  type TimeTransitionInput,
} from "./evaluate.js";

export {
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
} from "./constants.js";

export {
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  type EngagementDepth,
  type DepthAssignmentInput,
} from "./engagement-depth.js";

export {
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  RETENTION_TENURE_THRESHOLDS_DAYS,
  RETENTION_RECENCY_MULTIPLIERS,
  tenureBucket,
  recencyBucket,
  recencyThresholdDays,
  tenureBucketRange,
  recencyBucketRange,
  isSegmentTriggerConfig,
  matchesSegmentTrigger,
  type RetentionTenureBucket,
  type RetentionRecencyBucket,
  type SegmentTriggerConfig,
} from "./retention-grid.js";
