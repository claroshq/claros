/**
 * Template studio turn: one operator message in, a reply and (when the
 * model applied a change) a new template out.
 *
 * Every template the model returns is checked with validateLayoutSource
 * before it reaches the operator; one repair round is allowed, then the
 * turn fails and the working copy stays as it was. The send path never
 * calls this: the LLM shapes templates at authoring time only.
 */
import { checkLayoutSource, validateLayoutSource, type LintIssue } from "@claros/core";
import type { LlmProvider, ChatMessage } from "./providers/types.js";
import {
  buildTemplateStudioMessages,
  buildTemplateStudioRepairMessage,
  type TemplateStudioPromptContext,
} from "./prompts/template-studio.js";

export const STUDIO_TEMPERATURE = 0.2;
export const STUDIO_MAX_TOKENS = 12_000;

export type StudioDecision = "applied" | "proposed" | "answered" | "off_topic" | "failed";

export interface TemplateStudioResult {
  decision: StudioDecision;
  /** The assistant's message for the chat. */
  reply: string;
  /** The new template when decision is "applied", else null. */
  source: string | null;
  /** checkLayoutSource findings for the template the operator now has. */
  findings: LintIssue[];
  /** Rules among the findings that the change introduced. */
  newFindings: string[];
  tokens: number;
}

export interface ParsedStudioOutput {
  reply: string;
  decision: Exclude<StudioDecision, "failed"> | null;
  template: string | null;
}

function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]!.trim() : null;
}

/** Parse the tagged output. Tolerates a fenced template and a missing decision. */
export function parseStudioOutput(raw: string): ParsedStudioOutput {
  let template = tag(raw, "template");
  if (template) template = template.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (template === "") template = null;
  const d = (tag(raw, "decision") ?? "").toLowerCase().replace(/[^a-z_]/g, "");
  const decision = (["applied", "proposed", "answered", "off_topic"] as const).find((x) => x === d) ?? null;
  let reply = tag(raw, "reply");
  if (reply === null) {
    // No tags at all: treat the whole answer as the reply, never as a template.
    reply = raw.replace(/<template>[\s\S]*$/i, "").trim();
  }
  return { reply, decision: decision ?? (template ? "applied" : "answered"), template };
}

export async function assistTemplate(
  provider: LlmProvider,
  ctx: TemplateStudioPromptContext,
): Promise<TemplateStudioResult> {
  const before = new Set(ctx.findings.map((f) => f.rule));
  const messages: ChatMessage[] = buildTemplateStudioMessages(ctx);
  let tokens = 0;

  const call = async (msgs: ChatMessage[]) => {
    const r = await provider.complete({ messages: msgs, temperature: STUDIO_TEMPERATURE, max_tokens: STUDIO_MAX_TOKENS });
    const u = r.usage;
    tokens += u ? (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) : 0;
    return r.content;
  };

  const raw = await call(messages);
  let parsed = parseStudioOutput(raw);
  const unchanged = (reply: string, decision: StudioDecision): TemplateStudioResult => ({
    decision,
    reply,
    source: null,
    findings: ctx.findings,
    newFindings: [],
    tokens,
  });

  if (parsed.decision !== "applied" || parsed.template === null) {
    const decision = parsed.decision === "applied" ? "answered" : parsed.decision!;
    return unchanged(parsed.reply, decision);
  }

  let errors = validateLayoutSource(parsed.template);
  if (errors.length > 0) {
    const repairRaw = await call([...messages, { role: "assistant", content: raw }, buildTemplateStudioRepairMessage(errors)]);
    const repaired = parseStudioOutput(repairRaw);
    if (repaired.template) {
      errors = validateLayoutSource(repaired.template);
      parsed = { ...repaired, reply: repaired.reply || parsed.reply };
    }
    if (!repaired.template || errors.length > 0) {
      return unchanged(
        `I could not produce a valid template for that change (${errors.map((e) => e.message).join(" ")}). Nothing was changed; try rephrasing the request.`,
        "failed",
      );
    }
  }

  const findings = checkLayoutSource(parsed.template!);
  return {
    decision: "applied",
    reply: parsed.reply,
    source: parsed.template!,
    findings,
    newFindings: findings.map((f) => f.rule).filter((r) => !before.has(r)),
    tokens,
  };
}
