/**
 * Email content drafting: send context to LLM, validate output against schema.
 *
 * This is the third of four Brain functions:
 *   - compile() - task 11: prompt -> deterministic plan (runs once per prompt change)
 *   - decide()  - task 17: context -> action decision
 *   - draft()   - task 17: context -> email content (this file)
 *   - assess()  - task 20: (context + draft) -> pass/fail verdict
 */
import { draftOutputSchema, type DraftOutput } from "@claros/core";
import type { LlmProvider } from "./providers/types.js";
import { LlmProviderError } from "./providers/openai-compatible.js";
import { buildDraftMessages, type DraftPromptContext } from "./prompts/draft.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default temperature for draft generation (Appendix B). */
export const DRAFT_TEMPERATURE = 0.7;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DraftSuccess {
  ok: true;
  draft: DraftOutput;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface DraftFailure {
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

export type DraftResult = DraftSuccess | DraftFailure;

// ---------------------------------------------------------------------------
// draft()
// ---------------------------------------------------------------------------

/**
 * Draft email content for a contact whose decision has already been made.
 *
 * Steps:
 * 1. Build the prompt messages from the context.
 * 2. Call the LLM via the provider.
 * 3. Parse the response as JSON.
 * 4. Validate against draftOutputSchema.
 * 5. Return the validated draft or a descriptive error.
 *
 * This function does NOT retry LLM calls - the provider handles retries internally.
 * It does NOT write to the database - the caller (worker) handles persistence.
 * It does NOT render markdown to HTML - the deterministic side does that later.
 */
export async function draft(
  provider: LlmProvider,
  ctx: DraftPromptContext,
): Promise<DraftResult> {
  // Build messages
  const messages = buildDraftMessages(ctx);

  // Call LLM
  let rawContent: string;
  let usage: DraftSuccess["usage"];
  try {
    const result = await provider.complete({
      messages,
      temperature: DRAFT_TEMPERATURE,
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
  const validation = draftOutputSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Draft validation failed: ${issues}`,
    };
  }

  return {
    ok: true,
    draft: validation.data,
    usage,
  };
}
