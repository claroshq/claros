/**
 * @claros/brain-oss - Brain interface and community implementation.
 * Provides the Brain contract and its community implementation.
 *
 * Exports:
 *   - Brain interface (decide + draft + assess) - tasks 17, 20
 *   - compile() - task 11 (flow prompt -> deterministic plan)
 *   - decide()  - task 17 (contact context -> send/skip/wait decision)
 *   - draft()   - task 17 (contact context -> email subject + body_markdown)
 *   - assess()  - task 20 (context + draft -> pass/fail value gate)
 *   - LLM provider interface + OpenAI-compatible implementation
 *   - Prompt builders for compile/decide/draft/assess
 *   - Zod output schemas for decide, draft, and assess
 */

// ---------------------------------------------------------------------------
// Brain context types (decide + draft - task 17)
// ---------------------------------------------------------------------------

/**
 * Context passed to brain.decide().
 * Carries the information the Brain needs to make a send/skip/wait decision
 * for a specific contact at a specific flow step. The concrete populated type
 * used at runtime is DecidePromptContext (packages/brain-oss/src/prompts/decide.ts).
 * This interface exists for the Brain contract used by the edition system.
 */
export interface DecideContext {
  [key: string]: unknown;
}

/**
 * Context passed to brain.draft().
 * Carries the information the Brain needs to generate email content.
 * The concrete populated type used at runtime is DraftPromptContext
 * (packages/brain-oss/src/prompts/draft.ts). This interface exists for the
 * Brain contract used by the edition system.
 */
export interface DraftContext {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Brain output types (decide + draft - task 17)
// ---------------------------------------------------------------------------

/**
 * Decision result from brain.decide().
 *
 * action: the send/no-send verdict.
 *   - "contact": proceed - draft the email and queue for approval.
 *   - "skip": do not send - record reasoning and mark message as skipped.
 *   - "wait": treat as skip for this slice (task 17 impl decision 3).
 *
 * confidence: advisory value only. Must not appear in any branch condition.
 * If present, callers record it in brain_reasoning for observability only.
 *
 * reasoning: optional human-readable explanation, stored in brain_reasoning.
 */
export interface BrainDecision {
  action: "contact" | "skip" | "wait";
  confidence?: number;
  reasoning?: string;
}

/**
 * Draft result from brain.draft().
 *
 * The Brain produces text only. The deterministic side renders markdown to
 * body_html and derives body_text at write time (task 17 impl decision 1).
 */
export interface BrainDraft {
  subject: string;
  body_markdown: string;
}

// ---------------------------------------------------------------------------
// Brain interface
// ---------------------------------------------------------------------------

/** Configuration for Brain initialization */
export interface BrainConfig {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
}

/** The Brain interface */
export interface Brain {
  decide(context: DecideContext): Promise<BrainDecision>;
  draft(context: DraftContext): Promise<BrainDraft>;
}

// ---------------------------------------------------------------------------
// Community Brain implementation (BYO LLM key)
// ---------------------------------------------------------------------------

/** Create the community Brain implementation (BYO LLM key).
 *
 * Note: this factory implements the Brain interface. It returns no-ops because the worker
 * does NOT use this interface at runtime - it imports decide(), draft(), and
 * assess() directly from brain-oss and calls them with fully-typed
 * DecidePromptContext / DraftPromptContext / AssessPromptContext. The Brain
 * interface exists for future server-side uses (e.g. streaming, agent integration). Until such a
 * use case exists, createOssBrain() returns skip/empty stubs that no production
 * code path reaches.
 */
export function createOssBrain(_cfg: BrainConfig): Brain {
  return {
    async decide(_context) {
      // Not reached by the worker - the worker calls decide() directly.
      return { action: "skip", reasoning: "createOssBrain: use decide() directly" };
    },
    async draft(_context) {
      // Not reached by the worker - the worker calls draft() directly.
      return { subject: "", body_markdown: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Zod output schemas for decide, draft, and assess (tasks 17.1, 20)
// ---------------------------------------------------------------------------

export {
  decideOutputSchema,
  draftOutputSchema,
  assessOutputSchema,
  type DecideOutput,
  type DraftOutput,
  type AssessOutput,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Flow compilation (task 11)
// ---------------------------------------------------------------------------

export { compile, type CompileResult, type CompileSuccess, type CompileFailure } from "./compile.js";

// ---------------------------------------------------------------------------
// Brain decide (task 17)
// ---------------------------------------------------------------------------

export {
  decide,
  DECISION_TEMPERATURE,
  type DecideResult,
  type DecideSuccess,
  type DecideFailure,
} from "./decide.js";

// ---------------------------------------------------------------------------
// Email content drafting (task 17)
// ---------------------------------------------------------------------------

export { draft, DRAFT_TEMPERATURE, type DraftResult, type DraftSuccess, type DraftFailure } from "./draft.js";

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

export type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from "./providers/index.js";

export {
  OpenAICompatibleProvider,
  LlmProviderError,
} from "./providers/index.js";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export { buildCompileMessages, type CompilePromptContext } from "./prompts/compile.js";
export { buildDecideMessages, type DecidePromptContext } from "./prompts/decide.js";
export { buildDraftMessages, type DraftPromptContext } from "./prompts/draft.js";
export { buildAssessMessages, type AssessPromptContext } from "./prompts/assess.js";

// ---------------------------------------------------------------------------
// Brain value gate (task 20, slice 20.1)
// ---------------------------------------------------------------------------

export {
  assess,
  ASSESS_TEMPERATURE,
  type AssessResult,
  type AssessSuccess,
  type AssessFailure,
} from "./assess.js";

export { renderMarkdownToHtml, markdownToText } from "./markdown.js";

export {
  draftOpening,
  chooseCandidate,
  capText,
  OPENING_MAX_CHARS,
  type ChooseOption,
  type JsonCallResult,
} from "./opening-choose.js";

// ---------------------------------------------------------------------------
// Template studio (authoring time only, never on the send path)
// ---------------------------------------------------------------------------

export {
  assistTemplate,
  parseStudioOutput,
  STUDIO_TEMPERATURE,
  STUDIO_MAX_TOKENS,
  type StudioDecision,
  type TemplateStudioResult,
  type ParsedStudioOutput,
} from "./template-studio.js";
export {
  buildTemplateStudioMessages,
  TEMPLATE_STUDIO_SYSTEM_PROMPT,
  STUDIO_HISTORY_TURNS,
  type TemplateStudioTurn,
  type TemplateStudioPromptContext,
} from "./prompts/template-studio.js";
