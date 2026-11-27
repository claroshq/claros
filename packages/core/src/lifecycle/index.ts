/**
 * Lifecycle state machine - public API.
 */
export {
  LIFECYCLE_STATES,
  LIFECYCLE_STATE_NAMES,
  GONE_QUIET,
  storedLifecycleState,
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
  isEngagementEvent,
  inactivityThresholdDays,
  type Transition,
  type EventTransitionInput,
  type TimeTransitionInput,
} from "./evaluate.js";

export {
  replayLifecycle,
  engagementCounters,
  upcomingTimeTransitions,
  ENGAGEMENT_COUNTER_BUCKET_DAYS,
  type ReplayEvent,
  type ReplayTransition,
  type ReplayResult,
} from "./replay.js";

export {
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
} from "./constants.js";

export {
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  ENGAGEMENT_DEPTHS,
  type EngagementDepth,
  type DepthAssignmentInput,
} from "./engagement-depth.js";

export {
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  RETENTION_TENURE_THRESHOLDS_DAYS,
  RETENTION_RECENCY_MULTIPLIERS,
  PAYING_PAYMENT_STATUSES,
  CONTACT_AUDIENCES,
  type ContactAudience,
  tenureBucket,
  recencyBucket,
  recencyThresholdDays,
  tenureBucketRange,
  recencyBucketRange,
  isSegmentTriggerConfig,
  isLifecycleSegmentTriggerConfig,
  type LifecycleSegmentTriggerConfig,
  matchesSegmentTrigger,
  type RetentionTenureBucket,
  type RetentionRecencyBucket,
  type SegmentTriggerConfig,
} from "./retention-grid.js";
