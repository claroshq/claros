/**
 * Compiled plan Zod schema - the validated shape of flows.compiled_plan.
 *
 * Derived from CLAROS_HANDOFF_V2.md section 5 (compiled plan example) and
 * the FlowStep type (task 10). Used by:
 *   - Task 11 (compilation worker): validates LLM output before storing.
 *   - Task 12 (execution engine): reads the plan for deterministic execution.
 *
 * The schema is strict on all fields including conditions. The condition
 * vocabulary is closed: exactly three step-level shapes and three plan-level
 * exit shapes. The execution engine (task 12d) evaluates these deterministically.
 */
import { z } from "zod";
import {
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
  conditionTreeSchema,
  conditionOrListSchema,
  audienceConditionOrListSchema,
} from "../conditions.js";

// ---------------------------------------------------------------------------
// Condition schemas (step-level)
// ---------------------------------------------------------------------------

/**
 * Step-level condition vocabulary. A condition is a proceed-if gate:
 * the step executes only when the condition evaluates to true.
 * If false, the step is skipped and the flow advances.
 *
 * Exactly three shapes are supported:
 *   1. { lifecycle_state: "<state>" } - contact is currently in this state
 *   2. { lifecycle_state_not: "<state>" } - contact is NOT in this state
 *   3. { event_since_step: "<event_name>" } - event occurred since reaching step
 *
 * Plus the contact conditions (../conditions.ts): trait (G4), history and
 * first_contact (G28).
 */
export const stepConditionLeafSchema = z.union([
  z.object({ lifecycle_state: z.string().min(1) }).strict(),
  z.object({ lifecycle_state_not: z.string().min(1) }).strict(),
  z.object({ event_since_step: z.string().min(1) }).strict(),
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
  // G3: the membership's anchor date still equals the contact's date trait.
  z.object({ date_unchanged: z.literal(true) }).strict(),
]);

/**
 * A step `condition` or `exit_condition` (P5b): one leaf, a combinator
 * (`{all: [...]}`, `{any: [...]}`, `{not: c}`), or a list (= all).
 */
export const stepConditionSchema = conditionOrListSchema(stepConditionLeafSchema, "stepCondition");

// ---------------------------------------------------------------------------
// Step schema
// ---------------------------------------------------------------------------

/**
 * A single step in the compiled execution plan.
 *
 * Required fields the LLM must always produce:
 *   - order: 1-based integer, unique within steps
 *   - action_type: from the action catalog (non-empty string)
 *   - delay: canonical format <int><m|h|d> (e.g. "0m", "3d", "2h")
 *
 * Optional fields (LLM may or may not produce):
 *   - window_policy: step-level override; defaults to flow-level if absent
 *   - template_ref: @template reference resolved from the prompt
 *   - kb_ref: @kb reference resolved from the prompt
 *   - brain_instruction: natural-language instruction for brain.draft()
 *   - condition: proceed-if gate (step executes only when true; skipped otherwise)
 *   - exit_condition: per-step exit trigger (if true, contact exits the flow)
 */
/** G11: one context source a step fetches at render time. */
export const stepContextSchema = z
  .object({
    /** Name of a product data source (settings.data_sources). */
    source: z.string().regex(/^[a-z0-9_]{1,64}$/, { message: "source must be a data source name ([a-z0-9_])" }),
    /** Passed to the source as `mode` (e.g. "normal", "inferred"). */
    mode: z.string().min(1).max(64).optional(),
    /** Passed to the source as `limit`. */
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** G18: pick a knowledge base entry for the message. */
export const kbSelectSchema = z
  .object({
    category: z.string().min(1).max(120),
    /** Never send an entry the contact already received (default true). */
    exclude_used: z.boolean().optional(),
    /** oldest_unused (default): the oldest eligible entry; best_match: the closest to the step's instruction. */
    pick: z.enum(["oldest_unused", "best_match"]).optional(),
    /** Prefer entries with a tag listed in this contact trait (a string or a list of strings). */
    tags_any_from_trait: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A named link of the product (settings.links key). */
const linkNameSchema = z.string().regex(/^[a-z0-9_]{1,64}$/, { message: "a link name ([a-z0-9_], see settings.links)" });

const durationString = z.string().regex(/^\d{1,6}(m|h|d)$/, { message: "must look like 14d, 12h or 30m" });

/** G27: one candidate of a choose step. */
export const chooseCandidateSchema = z
  .object({
    action_type: z.string().min(1).max(120),
    /** Audience conditions (trait, history, first_contact, lifecycle_state, combinators); a list must all hold. */
    when: audienceConditionOrListSchema.optional(),
    kb_select: kbSelectSchema.optional(),
    context: z.array(stepContextSchema).max(5).optional(),
    /** Not eligible when this action type was sent to the contact within this window. */
    cooldown: durationString.optional(),
    template_ref: z.string().optional(),
    brain_instruction: z.string().optional(),
    /** P5b: eyebrow label for this candidate's message (default: the step's). */
    eyebrow: z.string().min(1).max(60).optional(),
    /** P5b: named links this candidate may use (default: the step's). */
    allowed_links: z.array(linkNameSchema).min(1).max(20).optional(),
  })
  .strict();

export const compiledStepSchema = z.object({
  order: z.number().int().min(1),
  action_type: z.string().min(1),
  delay: z.string().regex(/^\d+(m|h|d)$/, {
    message: "delay must match format: <int><m|h|d> (e.g. '0m', '3d')",
  }),
  window_policy: z.enum(["immediate", "respect_window"]).optional(),
  template_ref: z.string().optional(),
  kb_ref: z.string().optional(),
  brain_instruction: z.string().optional(),
  condition: stepConditionSchema.optional(),
  exit_condition: stepConditionSchema.optional(),
  /** G3: an unsent message of this step is cancelled (reason 'expired') this long after it was created. */
  expires_after: z.string().regex(/^\d{1,6}(m|h|d)$/, { message: "expires_after must look like 2d, 12h or 30m" }).optional(),
  /** G11: data fetched from product data sources at render time. */
  context: z.array(stepContextSchema).max(5).optional(),
  /** G11: when a context source returns no data: skip the message or send anyway (default send). */
  on_empty: z.enum(["skip", "send"]).optional(),
  /** G11: when a context source fails: retry later (default), skip the message, or fail it. */
  on_error: z.enum(["defer", "skip", "fail"]).optional(),
  /** G18: pick a knowledge base entry for this message. */
  kb_select: kbSelectSchema.optional(),
  /** G27: "choose" lets the LLM pick one eligible candidate; default "send". */
  type: z.enum(["send", "choose"]).optional(),
  /** G27: the candidates of a choose step. */
  candidates: z.array(chooseCandidateSchema).min(1).max(20).optional(),
  /** G27: whether the LLM may answer "none" (default true). */
  allow_none: z.boolean().optional(),
  /** P5b: sender display name for this step (the address stays the transport's verified sender). */
  from_name: z.string().min(1).max(120).optional(),
  /** P5b: Reply-To address for this step. */
  reply_to: z.string().email().max(320).optional(),
  /** P5b: small label shown above the message body. */
  eyebrow: z.string().min(1).max(60).optional(),
  /** P5b: hidden preheader (inbox preview text) of the HTML message. */
  preheader: z.string().min(1).max(200).optional(),
  /** P5b: the named links (settings.links) this step may use; restricts the link allowlist. */
  allowed_links: z.array(linkNameSchema).min(1).max(20).optional(),
  /** P5b: at most one link besides the footer and unsubscribe links. */
  single_cta: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Exit condition schema (plan-level)
// ---------------------------------------------------------------------------

/**
 * A plan-level exit condition. When any of these fire, the contact exits the
 * flow entirely regardless of which step they are on.
 *
 * Three shapes:
 *   1. { event: "<name>" } - exit when event occurs during the membership
 *   2. { lifecycle_state_change: { to: "<state>" } } - exit on state transition
 *   3. Both keys present - exit when BOTH are true (AND)
 *   4. A contact condition: trait (exit when the trait matches, e.g. "exit
 *      when icp_configured becomes true"), history or first_contact.
 */
export const planExitLeafSchema = z.union([
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
  z.object({ event: z.string().min(1) }).strict(),
  z.object({ lifecycle_state_change: z.object({ to: z.string().min(1) }).strict() }).strict(),
  z.object({
    event: z.string().min(1),
    lifecycle_state_change: z.object({ to: z.string().min(1) }).strict(),
  }).strict(),
]);

/** A plan-level exit (P5b): a leaf or a combinator over leaves. */
export const planExitConditionSchema = conditionTreeSchema(planExitLeafSchema, "planExitCondition");

// ---------------------------------------------------------------------------
// Trigger schema (confirmation of the flow trigger in compiled form)
// ---------------------------------------------------------------------------

export const compiledTriggerSchema = z.object({
  type: z.enum(["lifecycle_transition", "event", "segment", "manual", "date_property", "date_schedule"]),
  condition: z.record(z.unknown()),
});

// ---------------------------------------------------------------------------
// Full compiled plan schema
// ---------------------------------------------------------------------------

/**
 * The top-level compiled plan stored in flows.compiled_plan.
 *
 * Structure:
 *   - trigger: confirms the trigger type and condition from the prompt
 *   - steps: ordered array of execution steps (min 1)
 *   - exit_conditions: optional plan-level exit triggers
 */
export const compiledPlanSchema = z.object({
  trigger: compiledTriggerSchema,
  steps: z.array(compiledStepSchema).min(1),
  exit_conditions: z.array(planExitConditionSchema).optional(),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type CompiledPlan = z.infer<typeof compiledPlanSchema>;
export type CompiledStep = z.infer<typeof compiledStepSchema>;
export type CompiledTrigger = z.infer<typeof compiledTriggerSchema>;
export type PlanExitCondition = z.infer<typeof planExitConditionSchema>;
export type StepCondition = z.infer<typeof stepConditionSchema>;
export type StepContext = z.infer<typeof stepContextSchema>;
export type KbSelect = z.infer<typeof kbSelectSchema>;
export type ChooseCandidate = z.infer<typeof chooseCandidateSchema>;

/** P5b: how a step presents its message (sender name, Reply-To, eyebrow, preheader). */
export interface StepPresentation {
  fromName: string | null;
  replyTo: string | null;
  eyebrow: string | null;
  preheader: string | null;
}

/**
 * The presentation fields of the plan step with `order`; for a choose step,
 * the picked candidate's eyebrow (matched by action type) wins over the
 * step's. Unknown plan shapes give nulls.
 */
export function stepPresentation(plan: unknown, order: number | null, actionType: string | null): StepPresentation {
  const none: StepPresentation = { fromName: null, replyTo: null, eyebrow: null, preheader: null };
  if (order === null || !plan || typeof plan !== "object") return none;
  const steps = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return none;
  const step = steps.find((s) => s && typeof s === "object" && (s as { order?: unknown }).order === order) as Record<string, unknown> | undefined;
  if (!step) return none;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  let eyebrow = str(step.eyebrow);
  if (actionType && Array.isArray(step.candidates)) {
    const cand = (step.candidates as Array<Record<string, unknown>>).find((c) => c && c.action_type === actionType);
    if (cand && str(cand.eyebrow)) eyebrow = str(cand.eyebrow);
  }
  return { fromName: str(step.from_name), replyTo: str(step.reply_to), eyebrow, preheader: str(step.preheader) };
}
