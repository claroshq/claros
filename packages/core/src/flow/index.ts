/**
 * Flow domain types and pure logic.
 *
 * FlowStep, FlowTrigger, FlowStatus, delay format, and the status
 * transition table all live here so that the API (write) and the
 * execution engine (task 12, read) use the same definitions.
 */

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

/**
 * A duration expressed as a positive integer followed by a unit:
 *   "0m"  = zero minutes (immediate)
 *   "30m" = 30 minutes
 *   "2h"  = 2 hours
 *   "3d"  = 3 days
 *
 * The integer must be >= 0. Fractional values are not accepted.
 * This is the canonical wire format; any other string is invalid.
 */
export type FlowDelay = string;

const DELAY_RE = /^(\d+)(m|h|d)$/;

export interface ParsedDelay {
  value: number;
  unit: "m" | "h" | "d";
}

/**
 * Parse a delay string into its numeric value and unit.
 * Returns null if the string does not match the format.
 */
export function parseDelay(raw: string): ParsedDelay | null {
  const match = DELAY_RE.exec(raw);
  if (!match) return null;
  return { value: parseInt(match[1]!, 10), unit: match[2] as "m" | "h" | "d" };
}

/**
 * Convert a ParsedDelay to milliseconds.
 * Exported for use by the execution engine (task 12).
 */
export function delayToMs(parsed: ParsedDelay): number {
  switch (parsed.unit) {
    case "m": return parsed.value * 60 * 1000;
    case "h": return parsed.value * 60 * 60 * 1000;
    case "d": return parsed.value * 24 * 60 * 60 * 1000;
  }
}

/**
 * True if the string is a valid delay in the canonical format.
 */
export function isValidDelay(raw: string): boolean {
  return parseDelay(raw) !== null;
}

// ---------------------------------------------------------------------------
// FlowStep
// ---------------------------------------------------------------------------

/**
 * A single step within a flow's steps array.
 *
 * Fields written by the API (create/update):
 *   order         - 1-based integer, must be unique within the flow
 *   action_type   - from the action catalog (non-empty string; catalog is
 *                   validated by the execution engine, not at write time)
 *   delay         - how long to wait before executing this step (FlowDelay)
 *   window_policy - whether this step obeys the tenant send window [v2]
 *   template_ref  - optional @template reference name
 *   kb_ref        - optional @kb reference name
 *   condition     - optional skip-if condition (opaque JSON; task 12 interprets)
 *   exit_condition- optional exit-flow condition (opaque JSON; task 12 interprets)
 *
 * Additional fields written ONLY by the compilation worker (task 11):
 *   brain_instruction - natural-language instruction for brain.draft()
 *
 * The API never validates brain_instruction or the opaque condition shapes.
 * It only validates the structural fields listed above.
 */
export interface FlowStep {
  order: number;
  action_type: string;
  delay: FlowDelay;
  window_policy: "immediate" | "respect_window";
  template_ref?: string;
  kb_ref?: string;
  condition?: unknown;
  exit_condition?: unknown;
  /** Written by task 11 only. May be present after compilation. */
  brain_instruction?: string;
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export type FlowTriggerType =
  | "lifecycle_transition"
  | "event"
  | "segment"
  | "manual";

export const FLOW_TRIGGER_TYPES: readonly FlowTriggerType[] = [
  "lifecycle_transition",
  "event",
  "segment",
  "manual",
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type FlowStatus = "draft" | "active" | "paused" | "archived";

export const FLOW_STATUSES: readonly FlowStatus[] = [
  "draft",
  "active",
  "paused",
  "archived",
];

/**
 * Status transition table. Only transitions listed here are permitted.
 *
 * "archived" is terminal: once a flow is archived, its status cannot change.
 * "paused" requires a prior active state: draft -> paused is rejected because
 * pausing something that was never running makes no semantic sense.
 *
 * Error messages are pre-defined so callers can surface them to operators
 * without losing context.
 */
export interface StatusTransitionRule {
  from: FlowStatus;
  to: FlowStatus;
  reason: string;
}

export const FLOW_STATUS_TRANSITIONS: readonly StatusTransitionRule[] = [
  { from: "draft",  to: "active",   reason: "Activating a draft flow." },
  { from: "draft",  to: "archived", reason: "Archiving a draft flow." },
  { from: "active", to: "paused",   reason: "Pausing an active flow." },
  { from: "active", to: "archived", reason: "Archiving an active flow." },
  { from: "paused", to: "active",   reason: "Re-activating a paused flow." },
  { from: "paused", to: "archived", reason: "Archiving a paused flow." },
];

/**
 * Returns an error message if the transition is not permitted, or null if it is.
 *
 * A return value of null means "allowed"; non-null is the human-readable reason
 * to send back as the 422 body.
 */
export function validateStatusTransition(
  from: FlowStatus,
  to: FlowStatus,
): string | null {
  if (from === to) {
    // No-op transition is always fine; callers may filter this out.
    return null;
  }
  if (from === "archived") {
    return `Cannot change the status of an archived flow. Archived flows are terminal.`;
  }
  if (to === "paused" && from === "draft") {
    return `A flow must be active before it can be paused. Current status: draft.`;
  }
  const allowed = FLOW_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
  if (!allowed) {
    return `Status transition from '${from}' to '${to}' is not permitted.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flow class
// ---------------------------------------------------------------------------

export type FlowClass = "critical" | "nurture";

export const FLOW_CLASSES: readonly FlowClass[] = ["critical", "nurture"];

// ---------------------------------------------------------------------------
// Re-entry policy
// ---------------------------------------------------------------------------

export type ReentryPolicy = "once" | "cooldown" | "every_time";

export const REENTRY_POLICIES: readonly ReentryPolicy[] = [
  "once",
  "cooldown",
  "every_time",
];

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export type FlowSource = "manual" | "library" | "brain_suggested";

export const FLOW_SOURCES: readonly FlowSource[] = [
  "manual",
  "library",
  "brain_suggested",
];

// ---------------------------------------------------------------------------
// Content mode
// ---------------------------------------------------------------------------

/**
 * How the flow produces email content:
 *   - "ai_drafted": the brain drafts each email per contact at send time.
 *     Requires an LLM provider.
 *   - "fixed_content": the person writes the emails once and they are sent
 *     as-is (with variable interpolation). No LLM needed.
 */
export type ContentMode = "ai_drafted" | "fixed_content";

export const CONTENT_MODES: readonly ContentMode[] = [
  "ai_drafted",
  "fixed_content",
];

// ---------------------------------------------------------------------------
// Approval mode
// ---------------------------------------------------------------------------

export type ApprovalMode = "require" | "auto";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["require", "auto"];

// ---------------------------------------------------------------------------
// Template approval mode (for fixed_content flows)
// ---------------------------------------------------------------------------

/**
 * Template review modes for person-written flows:
 *   - "template_reviewed": the template is reviewed once against real contact
 *     data. After that, messages send without per-message approval.
 *   - "per_message": every message enters the approval queue (same as
 *     approval_mode = "require" for AI-drafted flows).
 */
export type TemplateApprovalMode = "template_reviewed" | "per_message";

export const TEMPLATE_APPROVAL_MODES: readonly TemplateApprovalMode[] = [
  "template_reviewed",
  "per_message",
];

// ---------------------------------------------------------------------------
// Compiled plan (task 11)
// ---------------------------------------------------------------------------

export {
  compiledPlanSchema,
  compiledStepSchema,
  compiledTriggerSchema,
  planExitConditionSchema,
  stepConditionSchema,
  type CompiledPlan,
  type CompiledStep,
  type CompiledTrigger,
  type PlanExitCondition,
  type StepCondition,
} from "./compiled-plan.js";
