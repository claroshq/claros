/**
 * Brain decide: send context to LLM, validate output against decideOutputSchema.
 *
 * This is the second of four Brain functions:
 *   - compile() - task 11: prompt -> deterministic plan (runs once per prompt change)
 *   - decide()  - task 17: context -> action decision (runs per contact per step)
 *   - draft()   - task 17: context -> email content (runs per contact per step)
 *   - assess()  - task 20: (context + draft) -> pass/fail verdict (value gate)
 *
 * The function is pure: provider and context are parameters, no database access,
 * no tenant or crypto knowledge in brain-oss.
 */
import { decideOutputSchema, type DecideOutput } from "@claros/core";
import type { LlmProvider } from "./providers/types.js";
import { LlmProviderError } from "./providers/openai-compatible.js";
import { buildDecideMessages, type DecidePromptContext } from "./prompts/decide.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Temperature for decide calls (from Appendix B). */
export const DECISION_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DecideSuccess {
  ok: true;
  decision: DecideOutput;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface DecideFailure {
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

export type DecideResult = DecideSuccess | DecideFailure;

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

/**
 * Decide whether outreach to a contact is warranted for a given action type.
 *
 * Steps:
 * 1. Build the prompt messages from the context.
 * 2. Call the LLM via the provider with DECISION_TEMPERATURE and JSON mode.
 * 3. Parse the response as JSON.
 * 4. Validate against decideOutputSchema.
 * 5. Return the validated decision or a descriptive error.
 *
 * This function does NOT retry LLM calls - the provider handles retries internally.
 * It does NOT write to the database - the caller (worker) handles persistence.
 */
export async function decide(
  provider: LlmProvider,
  ctx: DecidePromptContext,
): Promise<DecideResult> {
  // Build messages
  const messages = buildDecideMessages(ctx);

  // Call LLM
  let rawContent: string;
  let usage: DecideSuccess["usage"];
  try {
    const result = await provider.complete({
      messages,
      temperature: DECISION_TEMPERATURE,
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
  const validation = decideOutputSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Decide output validation failed: ${issues}`,
    };
  }

  return {
    ok: true,
    decision: validation.data,
    usage,
  };
}
