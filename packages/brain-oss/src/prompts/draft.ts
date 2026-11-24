/**
 * System prompt for email content drafting.
 *
 * Instructs the LLM to write one email for a contact whose decision to send
 * has already been made. Output is JSON with subject and body_markdown.
 */
import type { ChatMessage } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Context passed to the prompt builder
// ---------------------------------------------------------------------------

/**
 * Context that the draft prompt uses to produce personalized email content.
 *
 * Populated by the context packet builder (task 18). The fields mirror the
 * spec's context packet (Section 3.5) plus the brain_instruction from the
 * compiled flow step. All fields are optional - the prompt builder includes
 * only what is provided.
 */
export interface DraftPromptContext {
  /** The compiled step's brain_instruction - tells the drafter what to write. */
  brain_instruction?: string;
  /** The action_type of this step (e.g. "nurture_value", "onboard_welcome"). */
  action_type?: string;
  /** Contact details the email is addressed to. */
  contact?: {
    name?: string;
    email?: string;
    company?: string;
    plan?: string;
    signup_date?: string;
  };
  /** Current lifecycle state and metadata. */
  lifecycle?: {
    state?: string;
    tenure_days?: number;
    engagement_depth?: string;
    payment_status?: string;
  };
  /** Tenure classification. */
  tenure?: {
    category?: string;
    days?: number;
  };
  /** Recent engagement cadence. */
  cadence?: {
    current_7d?: number;
    previous_7d?: number;
    trend?: string;
  };
  /** Behavioral signals. */
  behavior?: {
    last_action?: string;
    most_used_features?: string[];
    recent_events?: string[];
  };
  /** Prior contact history. */
  prior_contact?: {
    last_message_date?: string;
    last_message_type?: string;
    total_messages_sent?: number;
    messages_opened?: number;
    messages_clicked?: number;
  };
  /** Whether this is the first email ever sent to this contact. */
  first_contact?: boolean;
  /** KB context snippets retrieved for this step. */
  kb_context?: string;
  /**
   * Tenant-level product description (tenants.settings.brain_context).
   * Seeded by business model templates, editable via the settings API.
   * Always injected when present - the anti-hallucination anchor that tells
   * the drafter what the product is and is not. Protected from budget
   * truncation (see context-budget.ts).
   */
  brain_context?: string;
  /** The sender/product name for the From line. */
  sender_name?: string;
  /** The product/company name. */
  product_name?: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the email content drafter for Claros, a lifecycle email automation engine.

Your job: write ONE email for a specific contact. The decision to send this email has already been made and is not your concern. You do not decide whether to send and you do not choose timing - that decision is already made and given to you.

OUTPUT FORMAT (strict JSON, no markdown fences, no commentary outside the JSON):
{
  "subject": "<email subject line>",
  "body_markdown": "<email body in markdown>"
}

HARD CONSTRAINTS:
1. Output ONLY the JSON object. No explanation, no preamble, no markdown fences.
2. "body_markdown" MUST be standard markdown. No HTML tags. No inline styles. No link markup beyond standard markdown link syntax [text](url). This is a hard constraint - any HTML in the output is a failure.
3. "subject" must be a single line, no markdown formatting, no emoji unless the instruction explicitly requests it.
4. Write in the voice and tone appropriate to the action type and instruction given.
5. Personalize using the contact context provided. Reference specific behaviors, features, or data points when available.
6. Keep emails concise and actionable. Lifecycle emails are not newsletters.
7. Do not invent facts about the product that are not in the provided product context or KB snippets.
8. Do not include unsubscribe links or footer boilerplate - the deterministic engine adds those.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the messages array for a draft request.
 */
export function buildDraftMessages(ctx: DraftPromptContext): ChatMessage[] {
  const userParts: string[] = [];

  // Brain instruction (the primary directive)
  if (ctx.brain_instruction) {
    userParts.push(`INSTRUCTION:\n${ctx.brain_instruction}`);
  }

  // Action type
  if (ctx.action_type) {
    userParts.push(`\nACTION TYPE: ${ctx.action_type}`);
  }

  // Sender/product context
  if (ctx.product_name || ctx.sender_name) {
    const parts: string[] = [];
    if (ctx.product_name) parts.push(`Product: ${ctx.product_name}`);
    if (ctx.sender_name) parts.push(`Sender: ${ctx.sender_name}`);
    userParts.push(`\nPRODUCT:\n${parts.join("\n")}`);
  }

  // Tenant-level product description (anti-hallucination anchor)
  if (ctx.brain_context) {
    userParts.push(`\nPRODUCT CONTEXT:\n${ctx.brain_context}`);
  }

  // Contact details
  if (ctx.contact) {
    const c = ctx.contact;
    const parts: string[] = [];
    if (c.name) parts.push(`Name: ${c.name}`);
    if (c.email) parts.push(`Email: ${c.email}`);
    if (c.company) parts.push(`Company: ${c.company}`);
    if (c.plan) parts.push(`Plan: ${c.plan}`);
    if (c.signup_date) parts.push(`Signed up: ${c.signup_date}`);
    if (parts.length > 0) {
      userParts.push(`\nCONTACT:\n${parts.join("\n")}`);
    }
  }

  // Lifecycle state
  if (ctx.lifecycle) {
    const l = ctx.lifecycle;
    const parts: string[] = [];
    if (l.state) parts.push(`State: ${l.state}`);
    if (l.tenure_days != null) parts.push(`Tenure: ${l.tenure_days} days`);
    if (l.engagement_depth) parts.push(`Engagement: ${l.engagement_depth}`);
    if (l.payment_status) parts.push(`Payment: ${l.payment_status}`);
    if (parts.length > 0) {
      userParts.push(`\nLIFECYCLE:\n${parts.join("\n")}`);
    }
  }

  // Tenure
  if (ctx.tenure) {
    const t = ctx.tenure;
    const parts: string[] = [];
    if (t.category) parts.push(`Category: ${t.category}`);
    if (t.days != null) parts.push(`Days: ${t.days}`);
    if (parts.length > 0) {
      userParts.push(`\nTENURE:\n${parts.join("\n")}`);
    }
  }

  // Cadence
  if (ctx.cadence) {
    const cd = ctx.cadence;
    const parts: string[] = [];
    if (cd.current_7d != null) parts.push(`Current 7d visits: ${cd.current_7d}`);
    if (cd.previous_7d != null) parts.push(`Previous 7d visits: ${cd.previous_7d}`);
    if (cd.trend) parts.push(`Trend: ${cd.trend}`);
    if (parts.length > 0) {
      userParts.push(`\nCADENCE:\n${parts.join("\n")}`);
    }
  }

  // Behavior
  if (ctx.behavior) {
    const b = ctx.behavior;
    const parts: string[] = [];
    if (b.last_action) parts.push(`Last action: ${b.last_action}`);
    if (b.most_used_features && b.most_used_features.length > 0) {
      parts.push(`Most used features: ${b.most_used_features.join(", ")}`);
    }
    if (b.recent_events && b.recent_events.length > 0) {
      parts.push(`Recent events: ${b.recent_events.join(", ")}`);
    }
    if (parts.length > 0) {
      userParts.push(`\nBEHAVIOR:\n${parts.join("\n")}`);
    }
  }

  // Prior contact history
  if (ctx.prior_contact) {
    const p = ctx.prior_contact;
    const parts: string[] = [];
    if (p.last_message_date) parts.push(`Last message: ${p.last_message_date}`);
    if (p.last_message_type) parts.push(`Last type: ${p.last_message_type}`);
    if (p.total_messages_sent != null) parts.push(`Total sent: ${p.total_messages_sent}`);
    if (p.messages_opened != null) parts.push(`Opened: ${p.messages_opened}`);
    if (p.messages_clicked != null) parts.push(`Clicked: ${p.messages_clicked}`);
    if (parts.length > 0) {
      userParts.push(`\nPRIOR CONTACT:\n${parts.join("\n")}`);
    }
  }

  // First contact flag
  if (ctx.first_contact != null) {
    userParts.push(`\nFIRST CONTACT: ${ctx.first_contact ? "yes" : "no"}`);
  }

  // KB context
  if (ctx.kb_context) {
    userParts.push(`\nKNOWLEDGE BASE CONTEXT:\n${ctx.kb_context}`);
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userParts.join("\n") },
  ];
}
