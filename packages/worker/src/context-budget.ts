/**
 * Context packet token budget estimation and truncation - slice 18.4.
 *
 * Implements the spec-defined approximation, truncation order, and recording
 * contract from §3.5 [impl] notes (1), (2), and (3):
 *
 * Estimation (impl note 1):
 *   Token count approximated as Math.ceil(charCount / 4). No tokenizer
 *   dependency. Rounding conservatively means the estimate overstates rather
 *   than understates. The estimate is computed on the assembled messages as
 *   they will actually be sent (system prompt + user message), not on the
 *   context struct in isolation.
 *
 * Budget scope (impl note 2):
 *   MAX_CONTEXT_TOKENS (4000) covers the system prompt and the user message
 *   together. Both buildDraftMessages() and buildDecideMessages() from
 *   brain-oss are used to assemble the real payloads for measurement.
 *
 * Dual-path budgeting (step 0a fix):
 *   Each message triggers two LLM calls: decide() then draft(). Each has its
 *   own system prompt and user message. The decide system prompt is longer
 *   than draft's (1767 vs 1393 chars), making the decide path the larger of
 *   the two for any given context data. Truncation is computed once against
 *   the larger (decide) path. After truncation, the draft path is verified to
 *   also fit. If it does not (which would indicate the size relationship
 *   changed), a warning is emitted. This ensures both calls see the same
 *   contact data and avoids incoherent reasoning chains where decide sees
 *   different sections than draft.
 *
 * Three-path budgeting (task 20):
 *   After draft() completes, the assessment call (assess()) is checked against
 *   budget using the ACTUAL draft body (not a reserve estimate). The context
 *   sections were already truncated before the draft call; they are not
 *   re-truncated for the assess path (which would create incoherence between
 *   what was drafted and what is assessed). If the assess call exceeds budget
 *   after full context truncation, a warning is emitted and the call proceeds
 *   anyway - the same graceful overrun policy as the decide/draft paths.
 *
 *   Why post-draft re-check rather than a reserve:
 *     The draft body size varies 5x between short and long emails, so a reserve
 *     is an estimate of an estimate. Using the actual draft body gives an exact
 *     measurement. The only cost is one additional message assembly after
 *     draft() returns, which is cheap (no DB, no LLM).
 *
 * Measurement seam:
 *   The system prompt text lives in brain-oss (packages/brain-oss/src/prompts/
 *   draft.ts and decide.ts). This module lives in packages/worker (has DB
 *   context). The seam is: call buildDraftMessages(ctx) and
 *   buildDecideMessages(ctx) from brain-oss after each truncation step to
 *   measure the real assembled output. worker is allowed to import brain-oss
 *   (dependency graph: core <- adapters <- api, worker <- core, adapters,
 *   brain-oss). No database knowledge moves into brain-oss.
 *
 * Truncation order (impl note 3):
 *   When the assembled estimate exceeds MAX_CONTEXT_TOKENS, sections are
 *   dropped in this order:
 *     1. kb_context
 *     2. behavior.recent_events
 *     3. behavior.most_used_features
 *     4. cadence
 *   Protected sections (never truncated): user (contact identity), lifecycle,
 *   tenure, prior_contact, brain_context. brain_context is the tenant-level
 *   product description - the anti-hallucination anchor. Dropping it under
 *   budget pressure would remove the very section that bounds what the LLM
 *   may claim about the product, so it is protected. Its size is capped at
 *   the write path (BRAIN_CONTEXT_MAX_CHARS in settings.ts) so a protected
 *   section cannot unboundedly consume the budget.
 *
 * Over-budget with all droppable sections removed:
 *   If dropping every droppable section still leaves the estimate over budget,
 *   the context is returned as-is (all droppable sections already dropped) with
 *   the dropped list reflecting what was actually removed. A console.warn is
 *   emitted so the condition is observable. Rationale: the protected sections
 *   are capped by the contact schema (small, bounded fields) and the system
 *   prompt is fixed. In practice a remaining-over-budget after full truncation
 *   indicates an unusually large contact name / lifecycle state / prior-contact
 *   history. Truncating protected sections would degrade Brain quality more
 *   than a slightly over-budget prompt. The correct fix is to increase
 *   MAX_CONTEXT_TOKENS, not to corrupt the identity data. The LLM will process
 *   the prompt anyway (most LLMs handle slight budget overruns gracefully) and
 *   the operator is notified.
 *
 * Recording:
 *   The fact of truncation and which sections were dropped is returned to the
 *   caller in the TruncationResult.droppedSections array. The caller (assembler
 *   slice 18.5) is responsible for wiring this into the assembled packet.
 */
import {
  buildDraftMessages,
  buildDecideMessages,
  buildAssessMessages,
  type DraftPromptContext,
  type DecidePromptContext,
  type AssessPromptContext,
} from "@claros/brain-oss";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum context tokens for the assembled messages (system + user).
 * From Appendix B and §3.5 impl note (2).
 */
export const MAX_CONTEXT_TOKENS = 4_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Section names that are eligible for truncation (in drop order).
 * Matches the spec-defined order from §3.5 impl note (3).
 */
export type DroppableSection =
  | "kb_context"
  | "behavior.recent_events"
  | "behavior.most_used_features"
  | "cadence";

/** Result returned by applyBudgetTruncation and applyBudgetForBothPaths. */
export interface TruncationResult {
  /**
   * The (possibly truncated) context ready to pass to buildDraftMessages.
   * Identical to the input when nothing was dropped.
   */
  ctx: DraftPromptContext;
  /**
   * Ordered list of sections that were dropped to fit the budget.
   * Empty when no truncation was needed.
   */
  droppedSections: DroppableSection[];
  /**
   * Estimated token count for the decide path after truncation.
   * Present only when applyBudgetForBothPaths is used (dual-path budgeting).
   * When present, confirms the decide path was also measured against the budget.
   */
  decideEstimate?: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count for an assembled messages array.
 *
 * Formula: Math.ceil(totalCharCount / 4) per §3.5 impl note (1).
 * Rounding up (ceiling) means the estimate overstates rather than understates.
 *
 * @param messages - Assembled ChatMessage[] from buildDraftMessages() or buildDecideMessages().
 * @returns Estimated token count (always >= 0).
 */
export function estimateTokensFromMessages(
  messages: Array<{ role: string; content: string }>,
): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Estimate the token count for a DraftPromptContext as it will be sent.
 *
 * Assembles the context into the actual messages (system + user) via
 * buildDraftMessages and applies the char/4 approximation. This measures
 * the real assembled payload, not the context struct in isolation.
 *
 * @param ctx - The context to estimate.
 * @returns Estimated token count.
 */
export function estimateTokens(ctx: DraftPromptContext): number {
  const messages = buildDraftMessages(ctx);
  return estimateTokensFromMessages(messages);
}

/**
 * Estimate the token count for a DecidePromptContext as it will be sent.
 *
 * Assembles the context into the actual messages (system + user) via
 * buildDecideMessages and applies the char/4 approximation. This measures
 * the real assembled payload for the decide call specifically.
 *
 * @param ctx - The decide context to estimate.
 * @returns Estimated token count.
 */
export function estimateDecideTokens(ctx: DecidePromptContext): number {
  const messages = buildDecideMessages(ctx);
  return estimateTokensFromMessages(messages);
}

/**
 * Estimate the token count for an AssessPromptContext as it will be sent.
 *
 * Called AFTER draft() completes, using the actual draft body.
 * The context sections in assessCtx.draftCtx are already truncated by
 * applyBudgetForBothPaths; this function measures the assess path including
 * the actual draft body produced by brain.draft().
 *
 * @param ctx - The assess context (draftCtx + subject + body_markdown).
 * @returns Estimated token count for the assessment call.
 */
export function estimateAssessTokens(ctx: AssessPromptContext): number {
  const messages = buildAssessMessages(ctx);
  return estimateTokensFromMessages(messages);
}

/**
 * Check whether the assessment call fits within budget after the draft body is known.
 *
 * Called after draft() returns, with the actual subject and body_markdown.
 * Emits a console.warn if the estimate exceeds the budget, consistent with the
 * existing over-budget policy: proceed with a logged warning rather than failing.
 *
 * @param draftCtx     - The already-truncated draft context.
 * @param subject      - The draft subject line.
 * @param bodyMarkdown - The draft body in markdown.
 * @param budget       - Token budget (defaults to MAX_CONTEXT_TOKENS).
 * @returns The estimated token count for the assessment call.
 */
export function checkAssessBudget(
  draftCtx: DraftPromptContext,
  subject: string,
  bodyMarkdown: string,
  budget: number = MAX_CONTEXT_TOKENS,
): number {
  const assessCtx: AssessPromptContext = { draftCtx, subject, body_markdown: bodyMarkdown };
  const estimate = estimateAssessTokens(assessCtx);

  if (estimate > budget) {
    console.warn(
      `[context-budget] assess call estimated at ${estimate} tokens, ` +
        `exceeding budget of ${budget}. The context sections were already ` +
        `truncated; no further truncation is applied (would cause incoherence ` +
        `between the draft and the assessor). The LLM handles slight overruns ` +
        `gracefully. Consider increasing MAX_CONTEXT_TOKENS if this recurs.`,
    );
  }

  return estimate;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Apply budget truncation to a DraftPromptContext.
 *
 * If the assembled context fits within MAX_CONTEXT_TOKENS, it is returned
 * unchanged with an empty droppedSections array.
 *
 * If it exceeds the budget, sections are dropped in the spec-defined order
 * until the estimate fits or all droppable sections are exhausted:
 *   1. kb_context
 *   2. behavior.recent_events
 *   3. behavior.most_used_features
 *   4. cadence
 *
 * After each drop the estimate is re-measured on the freshly assembled
 * messages so that measurement reflects what will actually be sent.
 *
 * If dropping everything droppable still leaves the estimate over budget,
 * the fully-truncated context is returned with all dropped sections recorded
 * and a console.warn is emitted. Protected sections are never removed.
 *
 * @param ctx    - The context to (possibly) truncate. Not mutated.
 * @param budget - Token budget (defaults to MAX_CONTEXT_TOKENS).
 * @returns TruncationResult with the final context and the list of dropped sections.
 */
export function applyBudgetTruncation(
  ctx: DraftPromptContext,
  budget: number = MAX_CONTEXT_TOKENS,
): TruncationResult {
  // Fast path: fits already
  if (estimateTokens(ctx) <= budget) {
    return { ctx, droppedSections: [] };
  }

  // Work on a shallow copy so the caller's object is not mutated.
  let working = { ...ctx };
  // behavior is a nested object; copy it separately so field drops are
  // isolated to this function's scope.
  if (working.behavior !== undefined) {
    working.behavior = { ...working.behavior };
  }

  const droppedSections: DroppableSection[] = [];

  // Drop in spec-defined order, re-measuring after each drop.
  const steps: Array<() => void> = [
    () => {
      delete working.kb_context;
    },
    () => {
      if (working.behavior !== undefined) {
        delete working.behavior.recent_events;
      }
    },
    () => {
      if (working.behavior !== undefined) {
        delete working.behavior.most_used_features;
      }
    },
    () => {
      delete working.cadence;
    },
  ];

  const sectionNames: DroppableSection[] = [
    "kb_context",
    "behavior.recent_events",
    "behavior.most_used_features",
    "cadence",
  ];

  for (let i = 0; i < steps.length; i++) {
    // Apply the drop
    steps[i]!();
    droppedSections.push(sectionNames[i]!);

    // Re-measure on the assembled messages
    if (estimateTokens(working) <= budget) {
      return { ctx: working, droppedSections };
    }
  }

  // All droppable sections exhausted but still over budget.
  // Return as-is with all dropped sections recorded and emit a warning.
  // Protected sections (user, lifecycle, tenure, prior_contact, brain_context)
  // are not touched.
  console.warn(
    `[context-budget] assembled context exceeds budget of ${budget} tokens ` +
      `even after dropping all droppable sections ` +
      `(${sectionNames.join(", ")}). ` +
      `Remaining estimated tokens: ${estimateTokens(working)}. ` +
      `Protected sections (user, lifecycle, tenure, prior_contact, brain_context) were not truncated. ` +
      `Consider increasing MAX_CONTEXT_TOKENS if this occurs regularly.`,
  );

  return { ctx: working, droppedSections };
}

// ---------------------------------------------------------------------------
// Dual-path budget verification
// ---------------------------------------------------------------------------

/**
 * Convert a DraftPromptContext to the equivalent DecidePromptContext.
 *
 * The decide path uses a different interface shape (camelCase, slightly
 * different field names). This mapper produces the decide context that
 * corresponds to the same contact data, so the decide path can be measured
 * alongside the draft path.
 *
 * Note: DecidePromptContext.contact.lastSeen is populated here from an
 * optional `lastSeen` parameter because DraftPromptContext does not carry
 * lastSeen. The assembler passes it in.
 */
export function draftContextToDecideContext(
  draftCtx: DraftPromptContext,
  actionType: string,
  lastSeen?: string,
): DecidePromptContext {
  const decideCtx: DecidePromptContext = {
    actionType,
    contact: {
      name: draftCtx.contact?.name,
      email: draftCtx.contact?.email,
      company: draftCtx.contact?.company,
      plan: draftCtx.contact?.plan,
      signupDate: draftCtx.contact?.signup_date,
      lastSeen,
    },
    lifecycle: {
      state: draftCtx.lifecycle?.state ?? "unknown",
      tenureDays: draftCtx.lifecycle?.tenure_days,
      engagementDepth: draftCtx.lifecycle?.engagement_depth,
      paymentStatus: draftCtx.lifecycle?.payment_status,
    },
  };

  if (draftCtx.cadence) {
    decideCtx.cadence = {
      current7d: draftCtx.cadence.current_7d,
      previous7d: draftCtx.cadence.previous_7d,
      trend: draftCtx.cadence.trend,
    };
  }

  if (draftCtx.behavior) {
    decideCtx.behavior = {
      lastAction: draftCtx.behavior.last_action,
      mostUsedFeatures: draftCtx.behavior.most_used_features,
      recentEvents: draftCtx.behavior.recent_events,
    };
  }

  if (draftCtx.prior_contact) {
    decideCtx.priorContact = {
      lastMessageDate: draftCtx.prior_contact.last_message_date,
      lastMessageType: draftCtx.prior_contact.last_message_type,
      totalMessagesSent: draftCtx.prior_contact.total_messages_sent,
      messagesOpened: draftCtx.prior_contact.messages_opened,
      messagesClicked: draftCtx.prior_contact.messages_clicked,
    };
  }

  if (draftCtx.first_contact != null) {
    decideCtx.firstContact = draftCtx.first_contact;
  }

  if (draftCtx.brain_instruction) {
    decideCtx.brainInstruction = draftCtx.brain_instruction;
  }

  if (draftCtx.kb_context) {
    decideCtx.kbContext = draftCtx.kb_context;
  }

  if (draftCtx.brain_context) {
    decideCtx.brainContext = draftCtx.brain_context;
  }

  return decideCtx;
}

/**
 * Apply budget truncation for both the decide and draft paths.
 *
 * Design: the decide path has a larger system prompt than draft (1767 vs 1393
 * chars). This makes the decide assembled payload the larger of the two for
 * any given context data. Truncation is computed against the MAXIMUM of the
 * two estimates at each step, ensuring that whichever path is larger for the
 * current data fits within budget. After truncation, both paths are guaranteed
 * to fit (or both exceed budget if protected sections alone are too large).
 *
 * This ensures both LLM calls see the same contact data - no section is
 * visible to one call but invisible to the other.
 *
 * @param draftCtx   - The DraftPromptContext to truncate.
 * @param actionType - The action type for the decide context.
 * @param lastSeen   - Optional lastSeen for the decide context.
 * @param budget     - Token budget (defaults to MAX_CONTEXT_TOKENS).
 * @returns TruncationResult with the truncated draft context, dropped sections,
 *          and the decide estimate.
 */
export function applyBudgetForBothPaths(
  draftCtx: DraftPromptContext,
  actionType: string,
  lastSeen?: string,
  budget: number = MAX_CONTEXT_TOKENS,
): TruncationResult {
  // Measure both paths to find the larger
  const decideCtx = draftContextToDecideContext(draftCtx, actionType, lastSeen);
  const draftEstimate = estimateTokens(draftCtx);
  const initialDecideEstimate = estimateDecideTokens(decideCtx);
  const maxEstimate = Math.max(draftEstimate, initialDecideEstimate);

  // Fast path: both fit already
  if (maxEstimate <= budget) {
    return { ctx: draftCtx, droppedSections: [], decideEstimate: initialDecideEstimate };
  }

  // Work on a shallow copy so the caller's object is not mutated.
  let working = { ...draftCtx };
  if (working.behavior !== undefined) {
    working.behavior = { ...working.behavior };
  }

  const droppedSections: DroppableSection[] = [];

  const steps: Array<() => void> = [
    () => { delete working.kb_context; },
    () => { if (working.behavior !== undefined) { delete working.behavior.recent_events; } },
    () => { if (working.behavior !== undefined) { delete working.behavior.most_used_features; } },
    () => { delete working.cadence; },
  ];

  const sectionNames: DroppableSection[] = [
    "kb_context",
    "behavior.recent_events",
    "behavior.most_used_features",
    "cadence",
  ];

  for (let i = 0; i < steps.length; i++) {
    steps[i]!();
    droppedSections.push(sectionNames[i]!);

    // Re-measure both paths after each drop
    const curDraftEst = estimateTokens(working);
    const curDecideCtx = draftContextToDecideContext(working, actionType, lastSeen);
    const curDecideEst = estimateDecideTokens(curDecideCtx);
    const curMax = Math.max(curDraftEst, curDecideEst);

    if (curMax <= budget) {
      return { ctx: working, droppedSections, decideEstimate: curDecideEst };
    }
  }

  // All droppable sections exhausted but still over budget.
  const finalDecideCtx = draftContextToDecideContext(working, actionType, lastSeen);
  const finalDecideEst = estimateDecideTokens(finalDecideCtx);
  const finalDraftEst = estimateTokens(working);

  console.warn(
    `[context-budget] assembled context exceeds budget of ${budget} tokens ` +
      `even after dropping all droppable sections ` +
      `(${sectionNames.join(", ")}). ` +
      `Remaining estimated tokens: draft=${finalDraftEst}, decide=${finalDecideEst}. ` +
      `Protected sections (user, lifecycle, tenure, prior_contact, brain_context) were not truncated. ` +
      `Consider increasing MAX_CONTEXT_TOKENS if this occurs regularly.`,
  );

  return { ctx: working, droppedSections, decideEstimate: finalDecideEst };
}
