/**
 * Context packet assembler - slice 18.5.
 *
 * Composes the contact, events, flow, and KB modules (slices 18.1-18.3 plus
 * the KB search wiring) into a complete context packet for both the decide
 * and draft LLM calls, then applies budget truncation (slice 18.4).
 *
 * This is the single entry point the content worker uses to get populated
 * contexts from a claimed candidate.
 *
 * Design decisions:
 *
 * Failure behavior:
 *   If any underlying context query fails (throws), the assembler propagates
 *   the error to the caller. The content worker's existing try/catch leaves
 *   the message at 'generating' (or 'awaiting_content') for reap recovery.
 *   A partially assembled context is NEVER returned - the assembler is
 *   all-or-nothing for the required sections (contact, lifecycle, flow).
 *
 *   Exception: KB context is a soft dependency. Any failure in
 *   buildKbContextSection (provider error, DB error during similarity query,
 *   or any unexpected throw) degrades to absent kb_context; generation
 *   proceeds. The KB section is first to drop under budget pressure, so it
 *   must not halt generation. The boundary is precise: contact, lifecycle,
 *   and flow failures remain fatal; only KB failures are soft.
 *
 * Truncation reporting:
 *   The droppedSections list is logged at info level with the message ID.
 *   Recording it on the message row would require a schema change (new JSONB
 *   column), which is not permitted in this slice. The log captures what was
 *   dropped for operational observability. A BACKLOG entry exists for the
 *   schema-based recording option.
 *
 * Query ordering:
 *   Contact, events, and flow queries are issued concurrently (Promise.all).
 *   The KB query depends on flowResult.brainInstruction (for query text
 *   construction) and flowResult.kbRef, so it runs after the Promise.all
 *   resolves. This adds one serial step but is unavoidable given the
 *   dependency. The KB query is the most expensive (embedding API call);
 *   the contact/events/flow queries are cheap DB reads.
 *
 * Absent data:
 *   If a contact has no events, no prior messages, or no flow plan, the
 *   corresponding sections are simply absent (undefined) in the context.
 *   The prompt builders handle absent sections by omitting them from the
 *   assembled text. No fabrication.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DecidePromptContext, DraftPromptContext } from "@claros/brain-oss";
import { buildContactSections } from "./context-contact.js";
import { buildEventSections } from "./context-events.js";
import { buildFlowStepSection } from "./context-flow.js";
import { buildKbContextSection } from "./context-kb.js";
import type { DroppableSection } from "./context-budget.js";
import type { ContentCandidate } from "./content.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** The assembled context packet ready for both decide and draft calls. */
export interface AssembledContext {
  /** Context for the decide() call. */
  decideCtx: DecidePromptContext;
  /** Context for the draft() call. */
  draftCtx: DraftPromptContext;
  /**
   * The contact's lastSeen value (from contacts.last_seen_at).
   * Passed separately because DraftPromptContext does not carry it but
   * DecidePromptContext does. Needed by budget truncation for accurate
   * decide-path measurement.
   */
  lastSeen?: string;
  /**
   * template_ref from the compiled plan step, if present.
   * When set, the content worker skips decide/draft/assess and renders
   * the template directly.
   */
  templateRef?: string;
  /**
   * Sections that were dropped during budget truncation.
   * Empty when no truncation was needed. Populated by the caller after
   * applying applyBudgetForBothPaths.
   */
  droppedSections: DroppableSection[];
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the full context packet for a claimed content candidate.
 *
 * Composes the three context modules (contact, events, flow) into a unified
 * DraftPromptContext, applies dual-path budget truncation, then derives the
 * DecidePromptContext from the (possibly truncated) draft context.
 *
 * All queries are scoped by tenant_id. The function is all-or-nothing: if any
 * query fails, the error propagates to the caller (content worker) which
 * leaves the message at its current status for reap recovery.
 *
 * @param db        - Drizzle database instance.
 * @param candidate - The claimed message candidate (has contact, flow, tenant info).
 * @param now       - Current time (injected for testability).
 * @returns Assembled context ready for both LLM calls, or null if the contact
 *          cannot be found (indicates data integrity issue; caller handles as error).
 */
export async function assembleContext(
  db: Db,
  candidate: ContentCandidate,
  now: Date,
): Promise<AssembledContext | null> {
  const { tenantId, contactId, flowId, flowStepOrder, brainActionType } = candidate;
  const actionType = brainActionType ?? "nurture_value";
  const stepOrder = flowStepOrder ?? 1;

  // Issue contact, events, and flow queries concurrently.
  // Each is independently scoped by tenant_id; no cross-query dependency.
  const [contactResult, eventResult, flowResult] = await Promise.all([
    buildContactSections(db, tenantId, contactId, now),
    buildEventSections(db, tenantId, contactId, now),
    buildFlowStepSection(db, tenantId, flowId, stepOrder),
  ]);

  // Contact not found = data integrity issue. Return null so caller treats as error.
  if (contactResult === null) {
    return null;
  }

  // Build the KB query text: brain_instruction + ": " + action_type.
  // The action_type is always present; brain_instruction may be absent.
  // Concatenating both gives a richer query when the instruction is present
  // and a reasonable fallback (action_type alone) when it is absent.
  const kbQueryText = flowResult.brainInstruction
    ? `${flowResult.brainInstruction}: ${actionType}`
    : actionType;

  // KB context: run after flowResult is available (depends on kbRef + query text).
  // This is a soft dependency: ANY failure in the KB path degrades to absent
  // kb_context and generation continues. Only the KB section is treated this
  // way; failures in contact, lifecycle, or flow assembly remain fatal.
  //
  // Skip entirely on the template path: templates are pre-authored fixed content
  // that never consumes KB context. Attempting to resolve the embedding provider
  // when no LLM is configured produces a recurring "cannot build KB context"
  // warning on every template tick - noisy on healthy installs with no LLM.
  //
  // The internal callEmbedding failures (network, timeout, 401) are already
  // caught inside buildKbContextSection and return undefined. This outer
  // try-catch is the safety net for any unexpected throw from buildKbContextSection
  // itself (e.g. a DB error during the similarity query or pinned-entry fetch)
  // that would otherwise propagate through assembleContext and leave the message
  // at 'generating' for reap - an availability inversion where the lowest-priority
  // context section halts all generation.
  let kbContext: string | undefined;
  if (flowResult.templateRef) {
    // Template path: KB context is unused, skip the embedding call entirely.
    kbContext = undefined;
  } else {
    try {
      kbContext = await buildKbContextSection(
        db,
        tenantId,
        kbQueryText,
        flowResult.kbRef,
      );
    } catch (kbErr) {
      const msg = kbErr instanceof Error ? kbErr.message : String(kbErr);
      console.warn(
        `[assembler] KB context build failed for tenant ${tenantId} ` +
          `(message will proceed without KB context): ${msg}`,
      );
      kbContext = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Assemble the DraftPromptContext from the modules
  // ---------------------------------------------------------------------------

  const draftCtx: DraftPromptContext = {
    action_type: actionType,
    brain_instruction: flowResult.brainInstruction,
    sender_name: flowResult.senderName,
    product_name: flowResult.productName,
    brain_context: flowResult.brainContext,
    contact: {
      name: contactResult.contact.name,
      email: contactResult.contact.email,
      company: contactResult.contact.company,
      plan: contactResult.contact.plan,
      signup_date: contactResult.contact.signupDate,
    },
    lifecycle: {
      state: contactResult.lifecycle.state,
      tenure_days: contactResult.lifecycle.tenureDays,
      engagement_depth: contactResult.lifecycle.engagementDepth,
      payment_status: contactResult.lifecycle.paymentStatus,
    },
    tenure: contactResult.tenure
      ? { category: contactResult.tenure.category, days: contactResult.tenure.days }
      : undefined,
    cadence: {
      current_7d: eventResult.cadence.current7d,
      previous_7d: eventResult.cadence.previous7d,
      trend: eventResult.cadence.trend,
    },
    prior_contact: {
      last_message_date: contactResult.priorContact.lastMessageDate,
      last_message_type: contactResult.priorContact.lastMessageType,
      total_messages_sent: contactResult.priorContact.totalMessagesSent,
      messages_opened: contactResult.priorContact.messagesOpened,
      messages_clicked: contactResult.priorContact.messagesClicked,
    },
    first_contact: contactResult.firstContact,
    // kb_context populated from similarity search; undefined when no relevant
    // entries found or when the tenant has no embedded KB entries.
    kb_context: kbContext,
  };

  // Behavior section: only include if there are events
  if (eventResult.behavior.lastAction || eventResult.behavior.recentEvents || eventResult.behavior.mostUsedFeatures) {
    draftCtx.behavior = {
      last_action: eventResult.behavior.lastAction
        ? `${eventResult.behavior.lastAction.eventName ?? "identify"} at ${eventResult.behavior.lastAction.timestamp}`
        : undefined,
      recent_events: eventResult.behavior.recentEvents
        ? eventResult.behavior.recentEvents.map(
            (e) => `${e.eventName ?? "identify"} at ${e.timestamp}`,
          )
        : undefined,
      most_used_features: eventResult.behavior.mostUsedFeatures,
    };
  }

  // ---------------------------------------------------------------------------
  // Return the assembled contexts (budget truncation applied by caller)
  // ---------------------------------------------------------------------------

  // lastSeen is available in contactResult but not in DraftPromptContext
  // (decide has it, draft does not). Included in the result so the caller
  // can pass it to budget truncation for accurate decide-path measurement.
  const lastSeen = contactResult.contact.lastSeen;

  // Build DecidePromptContext directly from the assembled data.
  // This avoids depending on draftContextToDecideContext which imports from
  // context-budget (which in turn imports buildDraftMessages from brain-oss).
  const decideCtx: DecidePromptContext = {
    actionType,
    contact: {
      name: contactResult.contact.name,
      email: contactResult.contact.email,
      company: contactResult.contact.company,
      plan: contactResult.contact.plan,
      signupDate: contactResult.contact.signupDate,
      lastSeen,
    },
    lifecycle: {
      state: contactResult.lifecycle.state,
      tenureDays: contactResult.lifecycle.tenureDays,
      engagementDepth: contactResult.lifecycle.engagementDepth,
      paymentStatus: contactResult.lifecycle.paymentStatus,
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

  return {
    decideCtx,
    draftCtx,
    lastSeen,
    templateRef: flowResult.templateRef,
    droppedSections: [],
  };
}
