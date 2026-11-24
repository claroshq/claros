/**
 * Flow compilation: send prompt to LLM, validate output against schema.
 *
 * This is the first of four Brain functions:
 *   - compile() - task 11: prompt -> deterministic plan (runs once per prompt change)
 *   - decide()  - task 17: context -> action decision (runs per contact per step)
 *   - draft()   - task 17: context -> email content (runs per contact per step)
 *   - assess()  - task 20: (context + draft) -> pass/fail verdict (value gate)
 */
import { compiledPlanSchema, type CompiledPlan } from "@claros/core";
import type { LlmProvider } from "./providers/types.js";
import { buildCompileMessages, type CompilePromptContext } from "./prompts/compile.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CompileSuccess {
  ok: true;
  plan: CompiledPlan;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface CompileFailure {
  ok: false;
  error: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

// ---------------------------------------------------------------------------
// compile()
// ---------------------------------------------------------------------------

/**
 * Compile a natural-language flow description into a deterministic execution plan.
 *
 * Steps:
 * 1. Build the prompt messages from the context.
 * 2. Call the LLM via the provider.
 * 3. Parse the response as JSON.
 * 4. Validate against compiledPlanSchema.
 * 5. Return the validated plan or a descriptive error.
 *
 * This function does NOT retry LLM calls - the provider handles retries internally.
 * It does NOT write to the database - the caller (worker) handles persistence.
 */
export async function compile(
  provider: LlmProvider,
  ctx: CompilePromptContext,
): Promise<CompileResult> {
  // Build messages
  const messages = buildCompileMessages(ctx);

  // Call LLM
  let rawContent: string;
  let usage: CompileSuccess["usage"];
  try {
    const result = await provider.complete({
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    rawContent = result.content;
    usage = result.usage;
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
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
  const validation = compiledPlanSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Compiled plan validation failed: ${issues}`,
    };
  }

  return {
    ok: true,
    plan: validation.data,
    usage,
  };
}
