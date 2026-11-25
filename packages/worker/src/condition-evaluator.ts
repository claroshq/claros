/**
 * Condition evaluator for flow step conditions and plan-level exit conditions.
 *
 * Evaluates the closed vocabulary of condition shapes against contact state
 * and event history. Returns a discriminated result:
 *   - { outcome: "pass" } - condition is true, proceed
 *   - { outcome: "fail" } - condition is false, skip/do-not-exit
 *   - { outcome: "unknown_shape", message: string } - unrecognizable condition
 *
 * The evaluator is pure logic over its inputs. I/O (event queries) is handled
 * by the caller and passed in via the EventChecker interface.
 */
import {
  stepConditionSchema,
  isContactCondition,
  evaluateContactCondition,
  type StepCondition,
  type PlanExitCondition,
  type ContactConditionContext,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConditionResult =
  | { outcome: "pass" }
  | { outcome: "fail" }
  | { outcome: "unknown_shape"; message: string };

// ---------------------------------------------------------------------------
// Context passed to the evaluator
// ---------------------------------------------------------------------------

/**
 * Minimal contact state needed for condition evaluation.
 */
export interface ContactState {
  lifecycleState: string;
}

/**
 * Interface for checking whether an event occurred since a reference time.
 * The caller provides an implementation backed by a DB query.
 */
export interface EventChecker {
  /**
   * Returns true if an event with the given name occurred for the contact
   * since the reference time.
   */
  hasEventSince(eventName: string, since: Date): Promise<boolean>;
  /**
   * Lookups for trait, history and first_contact conditions (G4, G28).
   * Absent: those conditions are reported as unknown shapes.
   */
  contact?: ContactConditionContext;
}

async function contactCondition(condition: unknown, eventChecker: EventChecker): Promise<ConditionResult> {
  if (!eventChecker.contact) {
    return { outcome: "unknown_shape", message: `contact condition without a lookup context: ${JSON.stringify(condition)}` };
  }
  const r = await evaluateContactCondition(condition, eventChecker.contact);
  if (r === null) return { outcome: "unknown_shape", message: `unrecognized condition shape: ${JSON.stringify(condition)}` };
  return r ? { outcome: "pass" } : { outcome: "fail" };
}

// ---------------------------------------------------------------------------
// Step-level condition evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a step-level condition (proceed-if gate).
 *
 * Semantics:
 *   - pass: condition is true, the step should proceed (or exit fires)
 *   - fail: condition is false, the step should be skipped (or exit does not fire)
 *   - unknown_shape: the condition cannot be interpreted
 *
 * @param condition - The raw condition value from the compiled plan step
 * @param contact - Current contact state
 * @param eventChecker - Async event lookup
 * @param referenceSince - The time from which event_since_step is measured
 */
export async function evaluateStepCondition(
  condition: unknown,
  contact: ContactState,
  eventChecker: EventChecker,
  referenceSince: Date,
): Promise<ConditionResult> {
  // Validate shape against the schema
  const parsed = stepConditionSchema.safeParse(condition);
  if (!parsed.success) {
    return {
      outcome: "unknown_shape",
      message: `unrecognized condition shape: ${JSON.stringify(condition)}`,
    };
  }

  const cond: StepCondition = parsed.data;

  if (isContactCondition(cond)) {
    return contactCondition(cond, eventChecker);
  }

  if ("lifecycle_state" in cond) {
    return contact.lifecycleState === cond.lifecycle_state
      ? { outcome: "pass" }
      : { outcome: "fail" };
  }

  if ("lifecycle_state_not" in cond) {
    return contact.lifecycleState !== cond.lifecycle_state_not
      ? { outcome: "pass" }
      : { outcome: "fail" };
  }

  if ("event_since_step" in cond) {
    const found = await eventChecker.hasEventSince(cond.event_since_step, referenceSince);
    return found ? { outcome: "pass" } : { outcome: "fail" };
  }

  // TypeScript exhaustiveness check - should never reach here
  return {
    outcome: "unknown_shape",
    message: `unrecognized condition shape: ${JSON.stringify(condition)}`,
  };
}

// ---------------------------------------------------------------------------
// Plan-level exit condition evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single plan-level exit condition.
 *
 * Semantics:
 *   - pass: exit condition is met, the contact should exit the flow
 *   - fail: exit condition is not met
 *   - unknown_shape: the condition cannot be interpreted
 *
 * @param exitCondition - A single exit_conditions entry from the compiled plan
 * @param contact - Current contact state
 * @param eventChecker - Async event lookup
 * @param membershipEnteredAt - The time the membership was entered (for event lookups)
 */
export async function evaluatePlanExitCondition(
  exitCondition: unknown,
  contact: ContactState,
  eventChecker: EventChecker,
  membershipEnteredAt: Date,
): Promise<ConditionResult> {
  if (
    exitCondition === null ||
    exitCondition === undefined ||
    typeof exitCondition !== "object"
  ) {
    return {
      outcome: "unknown_shape",
      message: `exit condition is not an object: ${JSON.stringify(exitCondition)}`,
    };
  }

  if (isContactCondition(exitCondition)) {
    return contactCondition(exitCondition, eventChecker);
  }

  const ec = exitCondition as Record<string, unknown>;
  const hasEvent = typeof ec.event === "string" && ec.event.length > 0;
  const hasStateChange =
    ec.lifecycle_state_change !== null &&
    ec.lifecycle_state_change !== undefined &&
    typeof ec.lifecycle_state_change === "object" &&
    typeof (ec.lifecycle_state_change as Record<string, unknown>).to === "string" &&
    ((ec.lifecycle_state_change as Record<string, unknown>).to as string).length > 0;

  // Must have at least one of the two known keys
  if (!hasEvent && !hasStateChange) {
    return {
      outcome: "unknown_shape",
      message: `exit condition has no recognized keys: ${JSON.stringify(exitCondition)}`,
    };
  }

  // Check for unknown extra keys
  const knownKeys = new Set(["event", "lifecycle_state_change"]);
  const extraKeys = Object.keys(ec).filter((k) => !knownKeys.has(k));
  if (extraKeys.length > 0) {
    return {
      outcome: "unknown_shape",
      message: `exit condition has unknown keys [${extraKeys.join(", ")}]: ${JSON.stringify(exitCondition)}`,
    };
  }

  // Evaluate event part
  let eventPasses = true;
  if (hasEvent) {
    eventPasses = await eventChecker.hasEventSince(ec.event as string, membershipEnteredAt);
  }

  // Evaluate lifecycle_state_change part
  let stateChangePasses = true;
  if (hasStateChange) {
    const targetState = (ec.lifecycle_state_change as { to: string }).to;
    // lifecycle_state_change: { to: S } means "contact has transitioned to S"
    // We check whether the contact is currently in that state. This is an
    // approximation: the contact could have transitioned to S and then away.
    // But for the scan's purposes, being in state S now is the observable signal.
    stateChangePasses = contact.lifecycleState === targetState;
  }

  // Both parts must be true (AND semantics for combined conditions)
  if (eventPasses && stateChangePasses) {
    return { outcome: "pass" };
  }
  return { outcome: "fail" };
}

// ---------------------------------------------------------------------------
// Error message formatter
// ---------------------------------------------------------------------------

/**
 * Format a condition error message for storage in flow_memberships.condition_error.
 * Includes the step order (or "plan-level") and the offending shape.
 */
export function formatConditionError(
  location: { type: "step_condition" | "step_exit_condition" | "plan_exit"; stepOrder?: number },
  message: string,
): string {
  switch (location.type) {
    case "step_condition":
      return `step ${location.stepOrder} condition: ${message}`;
    case "step_exit_condition":
      return `step ${location.stepOrder} exit_condition: ${message}`;
    case "plan_exit":
      return `plan-level exit_conditions: ${message}`;
  }
}
