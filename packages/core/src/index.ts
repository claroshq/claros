/**
 * @claros/core - Pure logic, no I/O.
 * Contains domain types, state machines, and business rules.
 */
export const CLAROS_CORE_VERSION = "0.0.0";

/**
 * Maximum hours of clock skew tolerated between a client-supplied event
 * timestamp and the server time at ingestion.
 *
 * The ingest route (packages/api/src/routes/ingest.ts) clamps any
 * client-supplied timestamp to within +/- this many hours of server time.
 * The context-events builder (packages/worker) adds this same value as a
 * slack to the received_at partition-pruning bound so that events whose
 * timestamp is inside a semantic window but whose received_at is slightly
 * earlier (clock running ahead) are never excluded by the pruning filter.
 *
 * Both sides of the system derive from this single source so the values
 * cannot drift independently.
 */
export const INGEST_TIMESTAMP_CLAMP_HOURS = 72;

export {
  QUEUE,
  type QueueName,
  type ScanJobData,
  type CompileJobData,
  type TriggerCheckJobData,
  type DrainJobData,
  type ReapJobData,
  type CounterRolloverJobData,
  type PartitionMaintenanceJobData,
  type ContentGenerationJobData,
  type KbEmbedJobData,
  type AdvanceMembershipJobData,
  type ProcessMessageJobData,
  type DrainMessageJobData,
  type GridSnapshotJobData,
  type AlertsDigestJobData,
} from "./jobs.js";

export { dueTicks, TICK_INTERVAL_MINUTES, TICK_LATE_FACTOR, isPeriodicJob, tickName } from "./ticks.js";

export * from "./alerts.js";

export {
  matchesLifecycleTransition,
  matchesEventTrigger,
  sortByPriority,
  isReentryAllowed,
  contactEnrollmentLockKey,
  dedupLockKey,
  type LifecycleTransitionTriggerConfig,
  type EventTriggerConfig,
  type EnrollableFlow,
  type PriorMembership,
} from "./enrollment.js";

export {
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  VALID_TRANSITION_MAP,
  assertValidTransition,
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  type LifecycleState,
  type TransitionTrigger,
  type TransitionRule,
  type LifecycleConfig,
  type Transition,
  type EventTransitionInput,
  type TimeTransitionInput,
  type EngagementDepth,
  type DepthAssignmentInput,
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
} from "./lifecycle/index.js";

export {
  parseDelay,
  delayToMs,
  isValidDelay,
  validateStatusTransition,
  FLOW_TRIGGER_TYPES,
  FLOW_STATUSES,
  FLOW_STATUS_TRANSITIONS,
  FLOW_CLASSES,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  CONTENT_MODES,
  TEMPLATE_APPROVAL_MODES,
  compiledPlanSchema,
  compiledStepSchema,
  compiledTriggerSchema,
  planExitConditionSchema,
  stepConditionSchema,
  type FlowDelay,
  type ParsedDelay,
  type FlowStep,
  type FlowTriggerType,
  type FlowStatus,
  type StatusTransitionRule,
  type FlowClass,
  type ReentryPolicy,
  type FlowSource,
  type ApprovalMode,
  type ContentMode,
  type TemplateApprovalMode,
  type CompiledPlan,
  type CompiledStep,
  type CompiledTrigger,
  type PlanExitCondition,
  type StepCondition,
} from "./flow/index.js";

export {
  THROTTLE_DEFAULTS,
  resolveThrottleConfig,
  throttleConfigSchema,
  evaluateThrottleGate,
  resolveTimezone,
  isValidTimezone,
  type ThrottleConfig,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "./throttle/index.js";

export {
  decideOutputSchema,
  draftOutputSchema,
  assessOutputSchema,
  type DecideOutput,
  type DraftOutput,
  type AssessOutput,
} from "./brain.js";

export {
  BUSINESS_MODEL_TEMPLATES,
  BUSINESS_MODEL_TEMPLATE_LIST,
  BUSINESS_MODEL_IDS,
  type BusinessModelId,
  type BusinessModelTemplate,
  type TemplateFlow,
} from "./business-model-templates.js";

export {
  LIBRARY_TEMPLATES,
  LIBRARY_FLOW_WELCOME,
  type LibraryTemplate,
  type LibraryFlow,
  type InstallResult,
} from "./library-flows.js";

export {
  wrapInShell,
  wrapInTextShell,
  buildShellComplianceHtml,
  buildShellComplianceText,
  type BrandSettings,
  type EmailShellInput,
  type TextShellInput,
} from "./email-shell.js";

export {
  TOPIC_KINDS,
  TRANSPORT_KINDS,
  TOPIC_SLUG_PATTERN,
  isTopicKind,
  isTransportKind,
  routeForTopicKind,
  selectTransport,
  transportPolicyAllows,
  topicBlocks,
  carriesListUnsubscribe,
  type TopicKind,
  type TransportKind,
  type TransportRoute,
  type TransportRouting,
} from "./topics-transports.js";
