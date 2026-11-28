/**
 * System prompt for the Brain's decide function.
 *
 * Instructs the LLM to decide, for a given contact and action type, whether
 * outreach is warranted NOW. The model outputs a structured JSON decision
 * validated against decideOutputSchema. The model does NOT write email content
 * and does NOT choose timing - it only answers "should we reach out?".
 */
import type { ChatMessage } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Context passed to the prompt builder
// ---------------------------------------------------------------------------

/**
 * Context for a decide prompt. Populated by the context packet builder
 * (task 18). The fields mirror the spec's context packet (section 3.5).
 */
export interface DecidePromptContext {
  /** The action type being considered (from the action catalog, e.g. "nurture_value"). */
  actionType: string;

  /** Contact information. */
  contact: {
    name?: string;
    email?: string;
    company?: string;
    plan?: string;
    signupDate?: string;
    lastSeen?: string;
  };

  /** Lifecycle state information. */
  lifecycle: {
    state: string;
    tenureDays?: number;
    engagementDepth?: string;
    paymentStatus?: string;
  };

  /** Recent cadence (visit frequency). */
  cadence?: {
    current7d?: number;
    previous7d?: number;
    trend?: string;
  };

  /** Recent behavior and events. */
  behavior?: {
    lastAction?: string;
    mostUsedFeatures?: string[];
    recentEvents?: string[];
  };

  /** Prior contact history. */
  priorContact?: {
    lastMessageDate?: string;
    lastMessageType?: string;
    totalMessagesSent?: number;
    messagesOpened?: number;
    messagesClicked?: number;
  };

  /** Whether this would be the first outreach to the contact. */
  firstContact?: boolean;

  /** Optional brain instruction from the flow step. */
  brainInstruction?: string;

  /** Optional KB context relevant to this decision. */
  kbContext?: string;

  /**
   * Tenant-level product description (tenants.settings.brain_context).
   * Always injected when present; mirrors DraftPromptContext.brain_context
   * so both calls see the same product framing.
   */
  brainContext?: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the decision engine for Claros, a lifecycle email automation system.

Your job: decide whether reaching out to a specific contact RIGHT NOW is warranted. You are making a send/no-send decision for one specific action type. You are NOT writing any email content. You are NOT choosing timing or scheduling.

You will receive context about a contact (their lifecycle state, engagement, behavior, prior contact history) and the action type being considered.

OUTPUT FORMAT (strict JSON, no markdown fences, no commentary outside the JSON):
{
  "action": "contact" | "skip" | "wait",
  "reasoning": "<brief explanation of your decision>"
}

DECISION VALUES:
- "contact": Outreach is warranted. The contact would benefit from this message now.
- "skip": Outreach is not warranted. The contact should not receive this message.
- "wait": Not the right moment, but may be appropriate later.

DECISION CRITERIA:
1. Is the contact in a state where this action type is relevant?
2. Has enough time passed since their last outreach?
3. Does their recent behavior indicate this message would be valuable?
4. Would this message be redundant given recent interactions?
5. Is there a signal (engagement drop, milestone, etc.) that makes this timely?

RULES:
1. You MUST return exactly one JSON object with "action" and "reasoning" fields.
2. The "action" field MUST be one of: "contact", "skip", "wait".
3. The "reasoning" field MUST be a brief (1-3 sentence) explanation.
4. Do NOT include any fields beyond "action" and "reasoning".
5. Do NOT write email subject lines or body content.
6. Do NOT suggest alternative action types.
7. Be conservative: when uncertain, prefer "skip" over "contact".
8. Consider the contact's engagement trajectory, not just their current state.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the messages array for a decide request.
 */
export function buildDecideMessages(ctx: DecidePromptContext): ChatMessage[] {
  const userParts: string[] = [];

  userParts.push(`ACTION TYPE UNDER CONSIDERATION: ${ctx.actionType}`);

  // Tenant-level product description
  if (ctx.brainContext) {
    userParts.push(`\nPRODUCT CONTEXT:\n${ctx.brainContext}`);
  }

  // Contact info
  const contactLines: string[] = [];
  if (ctx.contact.name) contactLines.push(`Name: ${ctx.contact.name}`);
  if (ctx.contact.email) contactLines.push(`Email: ${ctx.contact.email}`);
  if (ctx.contact.company) contactLines.push(`Company: ${ctx.contact.company}`);
  if (ctx.contact.plan) contactLines.push(`Plan: ${ctx.contact.plan}`);
  if (ctx.contact.signupDate) contactLines.push(`Signup date: ${ctx.contact.signupDate}`);
  if (ctx.contact.lastSeen) contactLines.push(`Last seen: ${ctx.contact.lastSeen}`);
  if (contactLines.length > 0) {
    userParts.push(`\nCONTACT:\n${contactLines.join("\n")}`);
  }

  // Lifecycle
  const lifecycleLines: string[] = [`State: ${ctx.lifecycle.state}`];
  if (ctx.lifecycle.tenureDays != null) lifecycleLines.push(`Tenure: ${ctx.lifecycle.tenureDays} days`);
  if (ctx.lifecycle.engagementDepth) lifecycleLines.push(`Engagement depth: ${ctx.lifecycle.engagementDepth}`);
  if (ctx.lifecycle.paymentStatus) lifecycleLines.push(`Payment status: ${ctx.lifecycle.paymentStatus}`);
  userParts.push(`\nLIFECYCLE:\n${lifecycleLines.join("\n")}`);

  // Cadence
  if (ctx.cadence) {
    const cadenceLines: string[] = [];
    if (ctx.cadence.current7d != null) cadenceLines.push(`Visits last 7 days: ${ctx.cadence.current7d}`);
    if (ctx.cadence.previous7d != null) cadenceLines.push(`Visits previous 7 days: ${ctx.cadence.previous7d}`);
    if (ctx.cadence.trend) cadenceLines.push(`Trend: ${ctx.cadence.trend}`);
    if (cadenceLines.length > 0) {
      userParts.push(`\nCADENCE:\n${cadenceLines.join("\n")}`);
    }
  }

  // Behavior
  if (ctx.behavior) {
    const behaviorLines: string[] = [];
    if (ctx.behavior.lastAction) behaviorLines.push(`Last action: ${ctx.behavior.lastAction}`);
    if (ctx.behavior.mostUsedFeatures && ctx.behavior.mostUsedFeatures.length > 0) {
      behaviorLines.push(`Most frequent events (30 days; product use and billing/lifecycle events mixed): ${ctx.behavior.mostUsedFeatures.join(", ")}`);
    }
    if (ctx.behavior.recentEvents && ctx.behavior.recentEvents.length > 0) {
      behaviorLines.push(`Recent events: ${ctx.behavior.recentEvents.join(", ")}`);
    }
    if (behaviorLines.length > 0) {
      userParts.push(`\nBEHAVIOR:\n${behaviorLines.join("\n")}`);
    }
  }

  // Prior contact
  if (ctx.priorContact) {
    const priorLines: string[] = [];
    if (ctx.priorContact.lastMessageDate) priorLines.push(`Last message: ${ctx.priorContact.lastMessageDate}`);
    if (ctx.priorContact.lastMessageType) priorLines.push(`Last message type: ${ctx.priorContact.lastMessageType}`);
    if (ctx.priorContact.totalMessagesSent != null) priorLines.push(`Total sent: ${ctx.priorContact.totalMessagesSent}`);
    if (ctx.priorContact.messagesOpened != null) priorLines.push(`Opened: ${ctx.priorContact.messagesOpened}`);
    if (ctx.priorContact.messagesClicked != null) priorLines.push(`Clicked: ${ctx.priorContact.messagesClicked}`);
    if (priorLines.length > 0) {
      userParts.push(`\nPRIOR CONTACT:\n${priorLines.join("\n")}`);
    }
  }

  // First contact flag
  if (ctx.firstContact != null) {
    userParts.push(`\nFIRST CONTACT: ${ctx.firstContact ? "yes" : "no"}`);
  }

  // Brain instruction from the flow step
  if (ctx.brainInstruction) {
    userParts.push(`\nFLOW INSTRUCTION:\n${ctx.brainInstruction}`);
  }

  // KB context
  if (ctx.kbContext) {
    userParts.push(`\nKNOWLEDGE BASE CONTEXT:\n${ctx.kbContext}`);
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userParts.join("\n") },
  ];
}
