/**
 * Brain output Zod schemas - the validated shapes of brain.decide() and brain.draft().
 *
 * Defined in @claros/core so that both brain-oss and the execution engine
 * can import them without circular dependencies or duplicate dependency declarations.
 * Follows the same pattern as compiledPlanSchema.
 *
 * Used by:
 *   - Task 17 (brain interface): exported from brain-oss for external use.
 *   - Task 19 (content generation worker): validates Brain output at runtime.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// decideOutputSchema
// ---------------------------------------------------------------------------

/**
 * Schema for brain.decide() output.
 *
 * action: "contact" | "skip" | "wait"
 *   - "contact": Brain approves sending - proceed to draft.
 *   - "skip": Brain rules against sending - mark message as skipped (terminal).
 *   - "wait": treat as skip for this slice (task 17 impl decision 3).
 *
 * confidence: optional advisory number [0, 1]. Must not gate any branch.
 *   If present, callers record it in brain_reasoning for observability only.
 *
 * reasoning: optional string stored in brain_reasoning.
 */
export const decideOutputSchema = z.object({
  action: z.enum(["contact", "skip", "wait"]),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});

export type DecideOutput = z.infer<typeof decideOutputSchema>;

// ---------------------------------------------------------------------------
// draftOutputSchema
// ---------------------------------------------------------------------------

/**
 * Schema for brain.draft() output.
 *
 * subject: non-empty email subject line.
 * body_markdown: non-empty markdown body. The deterministic side renders this
 *   to body_html and derives body_text at write time (task 17 impl decision 1).
 */
export const draftOutputSchema = z.object({
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;

// ---------------------------------------------------------------------------
// assessOutputSchema (task 20 - value gate)
// ---------------------------------------------------------------------------

/**
 * Schema for brain.assess() output (task 20 slice 20.1).
 *
 * verdict: "pass" | "fail"
 *   - "pass": the draft meets the bar and should proceed to pending_approval.
 *   - "fail": the draft does not meet the bar and should be value_gated.
 *
 * reasoning: mandatory string explaining the verdict.
 *   Required (not optional) for both pass and fail so that pass/fail rates and
 *   the reasoning distribution can be monitored against real data. The bar and
 *   the rate of rejection are unvalidated starting values; reasoning is the
 *   primary instrument for calibration.
 */
export const assessOutputSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reasoning: z.string().min(1),
});

export type AssessOutput = z.infer<typeof assessOutputSchema>;
