/**
 * Two small LLM calls added for real products (P5):
 *
 *   draftOpening()    G29: one opening line for a fixed template's
 *                     {{brain.opening}} slot, capped in length.
 *   chooseCandidate() G27 / D19: pick one of the eligible candidates of a
 *                     `choose` step, or "none". The caller validates that the
 *                     choice is in the eligible set (it may retry once).
 *
 * Both use the drafting context (contact, lifecycle, behaviour, product
 * guidelines and language) and return validated JSON.
 */
import { z } from "zod";
import type { LlmProvider, ChatMessage } from "./providers/types.js";
import { LlmProviderError } from "./providers/openai-compatible.js";
import { buildDraftMessages, productSystemSuffix, type DraftPromptContext } from "./prompts/draft.js";

export type JsonCallResult<T> =
  | { ok: true; value: T; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { ok: false; error: string; statusCode?: number | null };

async function completeJson<T>(provider: LlmProvider, messages: ChatMessage[], schema: z.ZodType<T>, temperature: number): Promise<JsonCallResult<T>> {
  let raw: string;
  let usage;
  try {
    const r = await provider.complete({ messages, temperature, response_format: { type: "json_object" } });
    raw = r.content;
    usage = r.usage;
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      statusCode: err instanceof LlmProviderError ? err.statusCode : undefined,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `LLM returned invalid JSON: ${raw.slice(0, 200)}` };
  }
  const v = schema.safeParse(parsed);
  if (!v.success) return { ok: false, error: `LLM output invalid: ${v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ok: true, value: v.data, usage };
}

/** The user part of the drafting prompt (contact, lifecycle, behaviour, KB, context data). */
function contextText(ctx: DraftPromptContext): string {
  return buildDraftMessages(ctx).find((m) => m.role === "user")?.content ?? "";
}

// ---------------------------------------------------------------------------
// G29 opening line
// ---------------------------------------------------------------------------

export const OPENING_MAX_CHARS = 240;

const OPENING_SYSTEM = `You write the opening line of a lifecycle email for Claros. The rest of the email is a fixed template written by the product team; you see its subject and body. Write ONE short, personal opening line (one or two sentences) that fits this contact and leads naturally into the template. No greeting line on its own, no sign-off, no links, no markdown, no promises the template does not make. Use only facts given to you.

Return JSON only: {"opening": "<the line>"}`;

export async function draftOpening(
  provider: LlmProvider,
  input: { ctx: DraftPromptContext; templateSubject: string; templateBody: string; maxChars?: number },
): Promise<JsonCallResult<{ opening: string }>> {
  const max = input.maxChars ?? OPENING_MAX_CHARS;
  const messages: ChatMessage[] = [
    { role: "system", content: `${OPENING_SYSTEM}\n\nAt most ${max} characters.${productSystemSuffix(input.ctx)}` },
    {
      role: "user",
      content: `${contextText(input.ctx)}\n\nTEMPLATE SUBJECT:\n${input.templateSubject}\n\nTEMPLATE BODY:\n${input.templateBody.slice(0, 4000)}`,
    },
  ];
  const r = await completeJson(provider, messages, z.object({ opening: z.string().min(1) }), 0.7);
  if (!r.ok) return r;
  return { ...r, value: { opening: capText(r.value.opening.trim(), max) } };
}

/** Cut a text to at most `max` characters, at a word boundary when possible. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "");
}

// ---------------------------------------------------------------------------
// G27 choose
// ---------------------------------------------------------------------------

export interface ChooseOption {
  action_type: string;
  /** What this action is about (instruction, KB entry title, context summary). */
  description?: string;
}

const CHOOSE_SYSTEM = `You are the choose step of Claros, a lifecycle email engine. A flow offers a few candidate actions for one contact; all of them already passed the deterministic checks (cooldowns, history, consent, conditions, available content). Pick the ONE candidate that is most useful for this contact right now, or "none" when none of them would help. You do not write the email.

Return JSON only: {"choice": "<one action_type from the list, or none>", "reason": "<one sentence>"}`;

export async function chooseCandidate(
  provider: LlmProvider,
  input: { ctx: DraftPromptContext; candidates: ChooseOption[]; allowNone: boolean; retryNote?: string },
): Promise<JsonCallResult<{ choice: string; reason: string }>> {
  const list = input.candidates.map((c) => `- ${c.action_type}${c.description ? `: ${c.description}` : ""}`).join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: `${CHOOSE_SYSTEM}${input.allowNone ? "" : '\n\n"none" is not allowed here: pick one candidate.'}${productSystemSuffix(input.ctx)}` },
    {
      role: "user",
      content: `${contextText({ ...input.ctx, brain_instruction: undefined, action_type: undefined })}\n\nCANDIDATES:\n${list}${input.retryNote ? `\n\nNOTE: ${input.retryNote}` : ""}`,
    },
  ];
  const r = await completeJson(provider, messages, z.object({ choice: z.string().min(1), reason: z.string().optional() }), 0.2);
  return r.ok ? { ...r, value: { choice: r.value.choice, reason: r.value.reason ?? "" } } : r;
}
