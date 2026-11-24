/**
 * Brain assess: value gate for drafted email content (task 20, slice 20.1).
 *
 * This is the fourth Brain function:
 *   - compile()  - task 11: prompt -> deterministic plan (once per prompt change)
 *   - decide()   - task 17: context -> send/skip/wait decision
 *   - draft()    - task 17: context -> email content
 *   - assess()   - task 20: (context + draft) -> pass/fail verdict (this file)
 *
 * assess() runs AFTER draft(), on the produced subject + body_markdown, and
 * BEFORE the write to pending_approval. A failed verdict lands the message at
 * value_gated (terminal, distinct from skipped). A failed gate call (LLM error
 * or parse failure) is a transient failure - the message stays for reap, NOT
 * value_gated.
 *
 * [impl] Temperature: NOT DEFINED in Appendix B. Chosen as 0.1 (lower than
 * DECISION_TEMPERATURE = 0.3) because the assessment is a binary judgment
 * requiring high consistency. Our choice, not spec-derived.
 *
 * [impl] The gate is always on. No per-tenant or per-flow toggle in this slice.
 * A BACKLOG entry exists for the toggle ("value gate toggle") since a third LLM
 * call per message may warrant opt-out for high-volume tenants or flows.
 *
 * [impl] Budget note: the assessment payload carries the full draft body plus
 * the contact context summary. It is likely the largest of the three LLM calls.
 * The budget machinery must cover the assessment path before the worker is wired.
 */
import { assessOutputSchema, type AssessOutput } from "@claros/core";
import type { LlmProvider } from "./providers/types.js";
import { LlmProviderError } from "./providers/openai-compatible.js";
import { buildAssessMessages, type AssessPromptContext } from "./prompts/assess.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Temperature for assess calls.
 *
 * [impl] NOT DEFINED in Appendix B. Chosen as 0.1: the assessment is a binary
 * pass/fail judgment that benefits from high consistency. Lower than
 * DECISION_TEMPERATURE (0.3) because the decision space is simpler (two
 * outcomes vs three) and reproducibility matters more than creativity.
 * This is our choice.
 */
export const ASSESS_TEMPERATURE = 0.1;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AssessSuccess {
  ok: true;
  assessment: AssessOutput;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface AssessFailure {
  ok: false;
  error: string;
  /**
   * HTTP status from the provider when the failure came from an LLM call
   * (LlmProviderError.statusCode), null for network errors, undefined for
   * non-LLM failures (parse/validation). Lets the worker distinguish
   * permanent configuration faults (401/403/404) from transient ones.
   */
  statusCode?: number | null;
}

export type AssessResult = AssessSuccess | AssessFailure;

// ---------------------------------------------------------------------------
// assess()
// ---------------------------------------------------------------------------

/**
 * Assess whether a drafted email is worth sending to the contact.
 *
 * Steps:
 * 1. Build the prompt messages from the assess context.
 * 2. Call the LLM via the provider with ASSESS_TEMPERATURE and JSON mode.
 * 3. Parse the response as JSON.
 * 4. Validate against assessOutputSchema.
 * 5. Log the verdict and reasoning at info level for pass/fail rate monitoring.
 * 6. Return the validated assessment or a descriptive error.
 *
 * A gate failure (LLM error or parse failure) returns ok=false. The caller
 * (content worker) must treat this as a transient failure and leave the message
 * for reap - NOT mark it as value_gated. Only a validated verdict="fail" is a
 * gate rejection.
 *
 * This function does NOT retry LLM calls - the provider handles retries.
 * It does NOT write to the database - the caller handles persistence.
 */
export async function assess(
  provider: LlmProvider,
  ctx: AssessPromptContext,
): Promise<AssessResult> {
  // Build messages
  const messages = buildAssessMessages(ctx);

  // Call LLM
  let rawContent: string;
  let usage: AssessSuccess["usage"];
  try {
    const result = await provider.complete({
      messages,
      temperature: ASSESS_TEMPERATURE,
      response_format: { type: "json_object" },
    });
    rawContent = result.content;
    usage = result.usage;
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      statusCode: err instanceof LlmProviderError ? err.statusCode : undefined,
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return {
      ok: false,
      error: `LLM returned invalid JSON: ${rawContent.slice(0, 200)}`,
    };
  }

  // Validate against schema
  const validation = assessOutputSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Assess output validation failed: ${issues}`,
    };
  }

  const assessment = validation.data;

  // Log the verdict and reasoning at info level.
  // Pass/fail rates and reasoning distributions are the primary calibration
  // instrument for the value gate, since neither the bar nor the rates are
  // validated against real data yet.
  console.info(
    `[assess] verdict=${assessment.verdict} reasoning="${assessment.reasoning}"`,
  );

  return { ok: true, assessment, usage };
}
