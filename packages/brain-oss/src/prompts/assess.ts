/**
 * System prompt for the Brain's assess function (task 20, slice 20.1).
 *
 * The assessor judges whether a drafted email is worth sending to the specific
 * contact. It reads the full draft (subject + body) and the contact/lifecycle
 * context, and returns a pass/fail verdict with mandatory reasoning.
 *
 * [impl] Bar for passing: an email passes if it would plausibly cause the
 * recipient to take a positive action - engage more deeply, resolve an issue,
 * or learn something directly applicable to their current situation. Concrete
 * rejection triggers (all three ground the model against leniency):
 *   1. Generic: could apply to any user with no use of the provided context data.
 *   2. Misaligned: primarily a feature advertisement with no connection to the
 *      contact's demonstrated behavior or lifecycle state.
 *   3. Contradictory: ignores or contradicts explicit contact data (e.g., pushes
 *      a feature the contact already uses heavily, or urges upgrade when the
 *      contact is already on a paid plan).
 *
 * Why this bar: a model assessing its own output is lenient by default. The bar
 * must name concrete disqualifying conditions rather than ask an open-ended
 * question like "is this valuable?" - that resolves to "yes" most of the time.
 * The bar is a starting point; pass/fail rates against real data will determine
 * whether it needs tightening or relaxing (see BACKLOG.md "value gate toggle").
 *
 * The assessor cannot rewrite or improve the draft. It judges only. This is
 * enforced by the system prompt and by the schema (no draft field in output).
 *
 * [impl] Budget note: the assessment payload carries the full draft body text
 * in addition to a context summary. At typical draft lengths (200-800 chars
 * body), this call is likely the largest of the three (decide, draft, assess).
 * The budget machinery must be extended to cover the assessment path before the
 * worker is wired. See the next slice for the budget coverage requirement.
 */
import type { ChatMessage } from "../providers/types.js";
import type { DraftPromptContext } from "./draft.js";

// ---------------------------------------------------------------------------
// Assessment context
// ---------------------------------------------------------------------------

/**
 * Context passed to brain.assess().
 *
 * Carries the assembled draft context (same object used for the draft call)
 * plus the produced draft. No new assembly is needed - the caller passes
 * both from the same pipeline step.
 */
export interface AssessPromptContext {
  /** The same context that was passed to brain.draft(). */
  draftCtx: DraftPromptContext;
  /** The subject line produced by brain.draft(). */
  subject: string;
  /** The markdown body produced by brain.draft(). */
  body_markdown: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the quality gate for Claros, a lifecycle email automation engine.

Your job: decide whether a drafted lifecycle email is worth sending to this specific contact. You do NOT rewrite or improve the draft. You judge it as-is.

OUTPUT FORMAT (strict JSON, no markdown fences, no commentary outside the JSON):
{
  "verdict": "pass" | "fail",
  "reasoning": "<one or two sentences explaining your verdict>"
}

THE BAR: an email passes if it would plausibly cause this specific contact to take a positive action - engage more deeply, resolve an issue, or learn something directly applicable to their current situation.

AUTOMATIC FAIL - reject if ANY of the following is true:
1. GENERIC: the email could be sent to any user in this lifecycle state with no meaningful use of the specific contact data provided (name, company, plan, behavior, features used). A mail-merge with the contact's name does not count as personalization.
2. MISALIGNED: the email is primarily a feature advertisement with no visible connection to the contact's demonstrated behavior or lifecycle state. The action type and instruction must be reflected in the email's substance, not just its framing.
3. CONTRADICTORY: the email ignores or contradicts explicit contact data. Examples: pushing heavy adoption of a feature the contact already uses as their top feature; urging upgrade when the contact is already on a paid plan; sending a "we miss you" message to a contact marked as active.

PASS WHEN: the email references the contact's specific situation (their lifecycle state, tenure, behavior, or usage patterns) and offers something that is genuinely useful or timely for them right now.

RULES:
1. Output ONLY the JSON object with "verdict" and "reasoning". No other text.
2. "verdict" MUST be exactly "pass" or "fail".
3. "reasoning" MUST be a non-empty explanation. State which criterion was or was not met.
4. You CANNOT suggest changes. Your only output is the verdict and its reason.
5. When uncertain, prefer "fail" - the human approver can always override a failed gate; a weak email reaching a contact cannot be unsent.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the messages array for an assess request.
 *
 * The user message presents:
 * 1. A summary of the contact context (subset of the draft context fields).
 * 2. The action type and brain instruction.
 * 3. The full drafted email (subject + body).
 *
 * Contact context is condensed relative to the draft prompt: only fields
 * the assessor actually needs to apply the three criteria. The full KB context
 * and behavior event lists are omitted (the assessor needs the contact's
 * lifecycle state, plan, and key behavioral signals, not the raw event log).
 */
export function buildAssessMessages(ctx: AssessPromptContext): ChatMessage[] {
  const { draftCtx, subject, body_markdown } = ctx;
  const userParts: string[] = [];

  // Action type and instruction
  if (draftCtx.action_type) {
    userParts.push(`ACTION TYPE: ${draftCtx.action_type}`);
  }
  if (draftCtx.brain_instruction) {
    userParts.push(`INSTRUCTION: ${draftCtx.brain_instruction}`);
  }

  // Contact summary (subset: the fields needed to apply the three criteria)
  const contactLines: string[] = [];
  if (draftCtx.contact?.name) contactLines.push(`Name: ${draftCtx.contact.name}`);
  if (draftCtx.contact?.company) contactLines.push(`Company: ${draftCtx.contact.company}`);
  if (draftCtx.contact?.plan) contactLines.push(`Plan: ${draftCtx.contact.plan}`);
  if (draftCtx.contact?.signup_date) contactLines.push(`Signed up: ${draftCtx.contact.signup_date}`);
  if (contactLines.length > 0) {
    userParts.push(`\nCONTACT:\n${contactLines.join("\n")}`);
  }

  // Lifecycle
  if (draftCtx.lifecycle) {
    const l = draftCtx.lifecycle;
    const lifecycleLines: string[] = [];
    if (l.state) lifecycleLines.push(`State: ${l.state}`);
    if (l.tenure_days != null) lifecycleLines.push(`Tenure: ${l.tenure_days} days`);
    if (l.engagement_depth) lifecycleLines.push(`Engagement: ${l.engagement_depth}`);
    if (l.payment_status) lifecycleLines.push(`Payment: ${l.payment_status}`);
    if (lifecycleLines.length > 0) {
      userParts.push(`\nLIFECYCLE:\n${lifecycleLines.join("\n")}`);
    }
  }

  // Key behavioral signals (most used features only - concise for the assessor)
  if (draftCtx.behavior?.most_used_features && draftCtx.behavior.most_used_features.length > 0) {
    userParts.push(
      `\nTOP FEATURES USED: ${draftCtx.behavior.most_used_features.join(", ")}`,
    );
  }

  // The draft being assessed
  userParts.push(`\nDRAFT EMAIL TO ASSESS:`);
  userParts.push(`Subject: ${subject}`);
  userParts.push(`\n${body_markdown}`);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userParts.join("\n") },
  ];
}
