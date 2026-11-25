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
import { traitConditionSchema, historyConditionSchema, firstContactConditionSchema } from "../conditions.js";

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
export const stepConditionSchema = z.union([
  z.object({ lifecycle_state: z.string().min(1) }).strict(),
  z.object({ lifecycle_state_not: z.string().min(1) }).strict(),
  z.object({ event_since_step: z.string().min(1) }).strict(),
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
]);

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
export const planExitConditionSchema = z.union([
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

// ---------------------------------------------------------------------------
// Trigger schema (confirmation of the flow trigger in compiled form)
// ---------------------------------------------------------------------------

export const compiledTriggerSchema = z.object({
  type: z.enum(["lifecycle_transition", "event", "segment", "manual"]),
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
