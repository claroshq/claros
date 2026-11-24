/**
 * Business model templates - task 25.
 *
 * Three templates defined in code with stable string identifiers and a
 * schema version. MVP: hardcoded in code per the spec (§6, "Template Format
 * (V2: extensible)"). V2: standardised format (.md + YAML frontmatter) for
 * community contribution.
 *
 * [impl] Templates are code-only, not database rows. Stable identifier
 * ("preview_free" | "freemium" | "time_limited_trial") and a schemaVersion
 * field are provided so a later database-backed form can migrate cleanly
 * (identifier becomes the primary key; schemaVersion allows format evolution).
 *
 * [impl] Applying a template writes settings.lifecycle, settings.throttle,
 * settings.brain_context, and tenants.business_model. The template's
 * suggested_flows are created as draft flows (not compiled). See the apply
 * endpoint for the full contract.
 *
 * [impl] Brain context: stored at the tenant level in settings.brain_context
 * (no new column - settings is already a JSONB field). It is product-level
 * context, so duplicating it into every flow prompt_source would make it
 * uneditable in one place. The context assembler injects it into the
 * decide/draft prompts as the PRODUCT CONTEXT section (context-flow.ts);
 * the operator edits it via PATCH /v1/settings/tenant.
 *
 * [impl] Throttle fields sourced from the spec:
 *   max_emails_per_user_per_week and min_interval_between_emails_hours.
 *   The spec only defines these two per template. All other ThrottleConfig
 *   fields (send_window_*, batch_size_per_tick, drain_interval_minutes,
 *   critical_bypass_throttle) are left as defaults from the resolver.
 *
 * [impl] Lifecycle fields sourced from the spec:
 *   activation_window_days, natural_frequency_days, at_risk_missed_intervals,
 *   dormant_days, churned_days. The spec does not define
 *   engagement_depth_window_days or power_user_percentile for templates;
 *   these are left as defaults from the resolver.
 */
import type { LifecycleConfig } from "./lifecycle/states.js";
import type { ThrottleConfig } from "./throttle/defaults.js";

// ---------------------------------------------------------------------------
// Template identifier type
// ---------------------------------------------------------------------------

export type BusinessModelId =
  | "preview_free"
  | "freemium"
  | "time_limited_trial";

// ---------------------------------------------------------------------------
// Flow definition within a template
// ---------------------------------------------------------------------------

/**
 * A flow to be created when a template is applied.
 *
 * [impl] prompt_source values are authored by us - the spec provides
 * descriptive names and intent ("Activation curriculum (3-step, days 0/2/5)")
 * but not the natural-language prompt text. The prompts written here are
 * consistent with how the compiler expects flows to be described: they name
 * the flow's purpose, steps, timing, and exit conditions in natural language.
 * They are our work and NOT spec-derived content.
 */
export interface TemplateFlow {
  /** Short human-readable name for the flow. */
  name: string;
  /**
   * The natural-language prompt_source the compiler will use.
   * Authored by us (see [impl] note above).
   */
  prompt_source: string;
  /** Trigger type for the flow. */
  trigger_type: "lifecycle_transition" | "event" | "segment" | "manual";
  /** Trigger configuration matching the trigger_type. */
  trigger_config: Record<string, unknown>;
  /** Flow class: critical flows bypass throttle; nurture flows are throttled. */
  flow_class: "nurture" | "critical";
  /**
   * Default window policy for steps. Most lifecycle flows are 'immediate'
   * (welcome, curriculum) or 'respect_window' (nurture).
   */
  window_policy: "immediate" | "respect_window";
  /** Reentry policy for this flow. */
  reentry_policy: "once" | "cooldown" | "every_time";
}

// ---------------------------------------------------------------------------
// Template definition
// ---------------------------------------------------------------------------

export interface BusinessModelTemplate {
  /** Stable string identifier. Used as tenants.business_model value. */
  id: BusinessModelId;
  /** Human-readable name. */
  name: string;
  /** One-line description. */
  description: string;
  /**
   * Schema version for the template definition format.
   * Increment when the shape of this interface changes so a database-backed
   * migration can detect stale applied templates.
   */
  schemaVersion: 1;
  /** Lifecycle configuration overrides (merged over LIFECYCLE_DEFAULTS). */
  lifecycle: Pick<
    LifecycleConfig,
    | "activation_window_days"
    | "natural_frequency_days"
    | "at_risk_missed_intervals"
    | "dormant_days"
    | "churned_days"
  >;
  /** Throttle configuration overrides (merged over THROTTLE_DEFAULTS). */
  throttle: Pick<
    ThrottleConfig,
    "max_emails_per_user_per_week" | "min_interval_between_emails_hours"
  >;
  /**
   * Brain context paragraph written verbatim from the spec.
   * Stored in tenants.settings.brain_context. Consumed by the context
   * assembler (context-flow.ts) as the PRODUCT CONTEXT section of the
   * decide/draft prompts; operator-editable via PATCH /v1/settings/tenant.
   */
  brain_context: string;
  /** Suggested flows to create when the template is applied. */
  flows: TemplateFlow[];
}

// ---------------------------------------------------------------------------
// Template 1: Preview Free
// ---------------------------------------------------------------------------

const PREVIEW_FREE: BusinessModelTemplate = {
  id: "preview_free",
  name: "Preview Free",
  description: "Limited free tier designed to convert quickly",
  schemaVersion: 1,
  // Lifecycle config from spec §6, Template 1
  lifecycle: {
    activation_window_days: 7,
    natural_frequency_days: 3,
    at_risk_missed_intervals: 2,
    dormant_days: 14,
    churned_days: 30,
  },
  // Throttle overrides from spec §6, Template 1
  throttle: {
    max_emails_per_user_per_week: 3,
    min_interval_between_emails_hours: 24,
  },
  // Brain context verbatim from spec §6, Template 1
  brain_context:
    "This is a preview-free product. Free tier is intentionally limited to " +
    "give a taste of value. Conversion window is 3-7 days. After 10 days " +
    "without conversion, urgency increases. Focus on demonstrating premium " +
    "value quickly.",
  // [impl] Flow prompts are authored by us - not spec-derived.
  flows: [
    {
      name: "Activation Curriculum",
      prompt_source:
        "Send a 3-step activation curriculum to new users. " +
        "Step 1 (day 0, immediate): Welcome them, explain the one action that unlocks value, and link directly to it. " +
        "Step 2 (day 2, immediate): Check whether they completed the activation action. If not, remind them with a short tip that makes it easy. " +
        "Step 3 (day 5, immediate): Final activation nudge with social proof or a concrete example of what they get after activation. " +
        "Exit the flow the moment the user activates (lifecycle_state changes to activated). " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Feature Discovery",
      prompt_source:
        "Send a feature discovery email when a user activates. " +
        "Highlight two or three specific features they have not yet used based on their usage data. " +
        "Be concrete: name the feature, explain the benefit in one sentence, and link to it. " +
        "Do not push an upgrade in this email. Focus entirely on getting them deeper into the product. " +
        "Flow class: nurture. Reentry: cooldown 30 days.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "activated" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "cooldown",
    },
    {
      name: "Upgrade Soft",
      prompt_source:
        "Send a gentle upgrade suggestion 7 days after signup if the user has not converted. " +
        "Step 1 (day 7, respect_window): Acknowledge their free trial usage, highlight what they would gain on a paid plan, " +
        "and include a clear call-to-action to upgrade. Keep the tone helpful, not pushy. " +
        "Exit if the user upgrades (payment_status becomes paid or trial). " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "respect_window",
      reentry_policy: "once",
    },
    {
      name: "Upgrade Hard",
      prompt_source:
        "Send an urgent upgrade message on day 10 if the user still has not converted. " +
        "This is the last planned outreach before the free preview window closes. " +
        "Be direct: state what they lose access to, what it costs to keep it, and make it easy to act now. " +
        "A time-limited offer or a specific expiry date is appropriate here if the product has one. " +
        "Exit if the user upgrades. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Win-Back",
      prompt_source:
        "Send a win-back email when a user goes dormant. " +
        "Acknowledge the time gap, reference something specific they were doing before they went silent, " +
        "and give them one concrete reason to come back today. " +
        "Do not lead with the upgrade pitch - focus on reactivation first. " +
        "Exit if the user returns to active (lifecycle_state changes to engaged or activated). " +
        "Flow class: nurture. Reentry: cooldown 30 days.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "engaged", to: "dormant" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "cooldown",
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 2: Freemium
// ---------------------------------------------------------------------------

const FREEMIUM: BusinessModelTemplate = {
  id: "freemium",
  name: "Freemium",
  description: "Generous free tier, natural upgrade triggers",
  schemaVersion: 1,
  // Lifecycle config from spec §6, Template 2
  lifecycle: {
    activation_window_days: 14,
    natural_frequency_days: 7,
    at_risk_missed_intervals: 3,
    dormant_days: 45,
    churned_days: 120,
  },
  // Throttle overrides from spec §6, Template 2
  throttle: {
    max_emails_per_user_per_week: 1,
    min_interval_between_emails_hours: 72,
  },
  // Brain context verbatim from spec §6, Template 2
  brain_context:
    "This is a freemium product with a generous free tier. Users can stay " +
    "free forever and get real value. Do NOT push upgrades aggressively. " +
    "Focus on helping them succeed. Upgrade suggestions only when natural " +
    "triggers occur (team growth, limit approach). Nurture relationship " +
    "over months.",
  // [impl] Flow prompts authored by us.
  flows: [
    {
      name: "Activation Curriculum",
      prompt_source:
        "Send a 3-step activation curriculum to new users on a patient schedule. " +
        "Step 1 (day 0, immediate): Welcome them warmly. Explain the most valuable thing they can do in the product right now and link to it directly. " +
        "Step 2 (day 3, immediate): Follow up on whether they completed the activation step. Offer a tip that removes the most common friction point. " +
        "Step 3 (day 7, respect_window): Final encouragement with a specific success story or outcome example that shows what the product enables. " +
        "Exit the moment the user activates. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Feature Education",
      prompt_source:
        "Send a 4-week weekly feature education series after the user activates. " +
        "Each email focuses on one feature area and shows a concrete use case. " +
        "Tone: helpful and educational, never selling. Reference the contact's actual usage patterns when available. " +
        "Do not mention pricing or upgrades in any step. " +
        "Exit if the user unsubscribes or becomes dormant. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "activated" },
      flow_class: "nurture",
      window_policy: "respect_window",
      reentry_policy: "once",
    },
    {
      name: "Team Growth Upgrade",
      prompt_source:
        "Send an upgrade suggestion when usage signals that the user's team or usage has grown to where a paid plan makes sense. " +
        "Specifically: reference the usage signals (team size, usage volume, or feature depth) that triggered this message. " +
        "Frame the upgrade as a natural next step for where they are, not a sales pitch. " +
        "Offer a specific comparison: what they have now vs what they get on the paid plan. " +
        "Exit if the user upgrades. " +
        "Flow class: nurture. Reentry: cooldown 30 days.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "engaged", to: "at_risk" },
      flow_class: "nurture",
      window_policy: "respect_window",
      reentry_policy: "cooldown",
    },
    {
      name: "Usage Limit Approach",
      prompt_source:
        "Send a notification when the user is approaching their free-tier usage limit. " +
        "Be transparent: state the current usage, what the limit is, and what happens when they hit it. " +
        "Present the upgrade as a solution, not a warning. Keep the tone matter-of-fact. " +
        "Flow class: critical (usage limit signals bypass throttle). Reentry: every_time.",
      trigger_type: "event",
      trigger_config: { event: "usage_limit_approaching" },
      flow_class: "critical",
      window_policy: "immediate",
      reentry_policy: "every_time",
    },
    {
      name: "Long-Term Nurture",
      prompt_source:
        "Send a monthly value summary to long-term engaged free users. " +
        "Recap what they accomplished with the product in the past month (reference real events if available). " +
        "Celebrate their progress. Do not push an upgrade unless a natural trigger (limit, team growth) is also present. " +
        "The goal is to deepen the relationship, not to convert. " +
        "Flow class: nurture. Reentry: cooldown 30 days.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "engaged", to: "engaged" },
      flow_class: "nurture",
      window_policy: "respect_window",
      reentry_policy: "cooldown",
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 3: Time-Limited Trial
// ---------------------------------------------------------------------------

const TIME_LIMITED_TRIAL: BusinessModelTemplate = {
  id: "time_limited_trial",
  name: "Time-Limited Trial",
  description: "Fixed trial period with countdown urgency",
  schemaVersion: 1,
  // Lifecycle config from spec §6, Template 3
  lifecycle: {
    activation_window_days: 3,
    natural_frequency_days: 2,
    at_risk_missed_intervals: 2,
    dormant_days: 7,
    churned_days: 14,
  },
  // Throttle overrides from spec §6, Template 3
  throttle: {
    max_emails_per_user_per_week: 4,
    min_interval_between_emails_hours: 18,
  },
  // Brain context verbatim from spec §6, Template 3 (with [TRIAL_DAYS] as literal)
  brain_context:
    "This is a time-limited trial product. Trial is [TRIAL_DAYS] days. " +
    "Every day matters. Focus on getting the user to experience core value " +
    "before trial ends. Countdown urgency is appropriate in final days. " +
    "After trial expires, one grace period offer, then shift to win-back.",
  // [impl] Flow prompts authored by us.
  flows: [
    {
      name: "Trial Start Curriculum",
      prompt_source:
        "Send a 5-step curriculum to guide the user through their trial. " +
        "Step 1 (day 0, immediate): Welcome. State the trial length. Tell them the one thing they must do to get value before day 3. " +
        "Step 2 (day 1, immediate): Check on activation progress. If they have not done the key action yet, remove one barrier. Keep it short. " +
        "Step 3 (day 3, immediate): Midpoint check. Show them what they have unlocked so far. Highlight the most impactful feature they have not tried. " +
        "Step 4 (day 7, immediate): Urgency reminder. The trial is more than half over. List the top three things they should complete before it ends. " +
        "Step 5 (day 12, immediate): Final push. Specific, concrete reason to convert before the trial closes. " +
        "Exit the moment the user converts (payment_status becomes paid). " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Mid-Trial Check-In",
      prompt_source:
        "Send a personal check-in at day 7 of the trial. " +
        "Reference what the user has done so far in the trial. Acknowledge the time remaining. " +
        "Ask if they have any questions or blockers - offer a direct reply or a resource to unblock them. " +
        "Tone: human and helpful, not automated-feeling. " +
        "Exit if the user converts. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "respect_window",
      reentry_policy: "once",
    },
    {
      name: "Trial Ending Soon",
      prompt_source:
        "Send a trial expiry warning at day 12 of a 14-day trial. " +
        "Be explicit: 2 days left. State what they lose when the trial ends. " +
        "Make the upgrade call-to-action prominent and the path clear. " +
        "Include a specific benefit or feature they will miss most if they do not convert. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "signed_up", to: "signed_up" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Trial Expired - Grace Period",
      prompt_source:
        "Send a grace period offer immediately when the trial expires. " +
        "Acknowledge that the trial ended. Offer a short grace period (24-48 hours) or a one-time discount to convert. " +
        "Be direct and time-sensitive. This is the last conversion opportunity before moving to win-back. " +
        "Flow class: critical. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "activated", to: "at_risk" },
      flow_class: "critical",
      window_policy: "immediate",
      reentry_policy: "once",
    },
    {
      name: "Post-Trial Win-Back",
      prompt_source:
        "Send a win-back email 21 days after a user's trial ended without converting. " +
        "Acknowledge the time since trial. Remind them of what they built or explored during the trial. " +
        "Offer a clear and easy re-entry path. A special returning-user offer can be used if appropriate. " +
        "This is the last touch in this sequence. " +
        "Flow class: nurture. Reentry: once.",
      trigger_type: "lifecycle_transition",
      trigger_config: { from: "at_risk", to: "dormant" },
      flow_class: "nurture",
      window_policy: "immediate",
      reentry_policy: "once",
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All built-in business model templates, indexed by id. */
export const BUSINESS_MODEL_TEMPLATES: Readonly<
  Record<BusinessModelId, BusinessModelTemplate>
> = {
  preview_free: PREVIEW_FREE,
  freemium: FREEMIUM,
  time_limited_trial: TIME_LIMITED_TRIAL,
};

/** Ordered list for UI display. */
export const BUSINESS_MODEL_TEMPLATE_LIST: readonly BusinessModelTemplate[] = [
  PREVIEW_FREE,
  FREEMIUM,
  TIME_LIMITED_TRIAL,
];

export const BUSINESS_MODEL_IDS: readonly BusinessModelId[] = [
  "preview_free",
  "freemium",
  "time_limited_trial",
];
