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
  boundedEventProperties,
  MAX_TRIGGER_PROPERTIES_CHARS,
} from "./jobs.js";

export { dueTicks, TICK_INTERVAL_MINUTES, TICK_LATE_FACTOR, isPeriodicJob, tickName } from "./ticks.js";

export * from "./alerts.js";

export {
  matchesLifecycleTransition,
  matchesEventTrigger,
  triggerEventNames,
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
  isEngagementEvent,
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  ENGAGEMENT_DEPTHS,
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
  isLifecycleSegmentTriggerConfig,
  type LifecycleSegmentTriggerConfig,
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
  toFlowClass,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  CONTENT_MODES,
  TEMPLATE_APPROVAL_MODES,
  compiledPlanSchema,
  compiledStepSchema,
  stepContextSchema,
  kbSelectSchema,
  chooseCandidateSchema,
  stepPresentation,
  type StepPresentation,
  compiledTriggerSchema,
  planExitConditionSchema,
  planExitLeafSchema,
  stepConditionSchema,
  stepConditionLeafSchema,
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
  type StepContext,
  type KbSelect,
  type ChooseCandidate,
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
  applyWideBodyLayout,
  BRAND_LAYOUTS,
  TEXT_MEASURE,
  FONT_STACK,
  type BrandLayout,
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

export {
  WEBHOOK_EVENTS,
  INTERNAL_EVENTS,
  ANALYTICS_EVENT_MAP,
  ANALYTICS_SOURCE_EVENTS,
  ANALYTICS_SINKS,
  ANALYTICS_ENDPOINT_SLUG,
  PENDING_APPROVAL_WINDOW_MS,
  WEBHOOK_MAX_ATTEMPTS,
  isWebhookEvent,
  pendingApprovalBatch,
  endpointBatchMinutes,
  webhookBackoffMs,
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  type WebhookEvent,
  type OutboxEventName,
  type AnalyticsSink,
} from "./webhooks.js";

export {
  TRAIT_OPS,
  HISTORY_OPS,
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
  contactConditionSchema,
  traitValue,
  evaluateTrait,
  historySince,
  historyPasses,
  isContactCondition,
  evaluateContactCondition,
  evaluateAllContactConditions,
  evaluateAudienceCondition,
  evaluateConditionTree,
  conditionTreeSchema,
  conditionOrListSchema,
  conditionDepth,
  isCombinator,
  lifecycleStateConditionSchema,
  lifecycleStateNotConditionSchema,
  audienceLeafSchema,
  audienceConditionSchema,
  audienceConditionOrListSchema,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_ITEMS,
  cachedConditionContext,
  type TraitOp,
  type HistoryOp,
  type TraitCondition,
  type HistoryCondition,
  type FirstContactCondition,
  type ContactCondition,
  type SendHistoryFilter,
  type ContactConditionContext,
} from "./conditions.js";

export {
  linkTrackingSchema,
  CLICK_ID_PARAM,
  tagUrl,
  tagHtmlLinks,
  tagTextLinks,
  resolveLinkTracking,
  type LinkTracking,
  type LinkTagContext,
} from "./link-tracking.js";

export {
  CONFIG_SLUG,
  clarosConfigSchema,
  configFlowSchema,
  configTopicSchema,
  configTemplateSchema,
  configWebhookSchema,
  configAnalyticsSchema,
  configSettingsSchema,
  configTriggerSchema,
  type ClarosConfig,
  type ConfigFlow,
  type ConfigTopic,
  type ConfigTemplate,
  type ConfigWebhook,
  type ConfigAnalytics,
  type ConfigSettings,
} from "./config/schema.js";
export { zodToJsonSchema, configJsonSchema } from "./config/json-schema.js";
export {
  planConfig,
  SETTINGS_KEYS,
  sameJson,
  type ConfigState,
  type ConfigChange,
  type ConfigChangeKind,
  type ConfigOp,
  type ConfigPlan,
  type PlanDeps,
  type FlowValues,
  type StateTopic,
  type StateTemplate,
  type StateFlow,
  type StateTransport,
  type StateEndpoint,
} from "./config/plan.js";

export {
  SIGNED_DURATION_RE,
  DURATION_RE,
  LOCAL_TIME_RE,
  DATE_SLOT_GRACE_MS,
  MAX_SCHEDULE_SENDS,
  DATE_TRIGGER_TYPES,
  datePropertyTriggerSchema,
  dateScheduleTriggerSchema,
  durationMs,
  isDateTriggerType,
  parseDateTrigger,
  dateTriggerProperty,
  totalSlots,
  slotOffsetMs,
  parseDateValue,
  atLocalTime,
  dateTimezone,
  slotDue,
  firstOpenSlot,
  anchorWindow,
  stepForSlot,
  planStepFor,
  type DateTrigger,
  type DatePropertyTrigger,
  type DateScheduleTrigger,
} from "./dates.js";

export { PUBLIC_STRINGS, publicLanguage, publicStrings, type PublicStrings } from "./i18n.js";

export * from "./brand-logo.js";
export * from "./embeddings.js";
