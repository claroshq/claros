/**
 * Content generation worker - claims pending_generation messages, runs Brain
 * decide + draft + assess, and advances state.
 *
 * Scheduled every 5 minutes via pg-boss cron. Selects pending_generation
 * messages ordered by created_at ASC (FIFO). Uses FOR UPDATE SKIP LOCKED
 * for safe concurrency across multiple content workers.
 *
 * Processing order per message:
 *   1. Claim: pending_generation -> generating (atomic CTE with SKIP LOCKED).
 *   2. Resolve: look up the tenant's active LLM provider.
 *   3. Decide: call brain.decide() to determine action (contact | skip | wait).
 *      - skip/wait: mark as 'skipped', record reasoning. Terminal.
 *      - contact: advance to 'awaiting_content', proceed to draft.
 *   4. Draft: call brain.draft() to produce subject + body_markdown.
 *   5. Assess: call brain.assess() to gate the draft for value.
 *      - fail: mark as 'value_gated', preserve draft content + reasoning. Terminal.
 *      - pass: proceed.
 *      - error: leave at 'awaiting_content' for reap (transient, NOT value_gated).
 *   6. Render: convert markdown to HTML (sanitized), derive plain text.
 *   7. Write: advance to 'pending_approval' with CAS (WHERE status = 'awaiting_content').
 *
 * State machine:
 *   generating -> awaiting_content (decide returns "contact")
 *   awaiting_content -> pending_approval (draft + assess pass)
 *   awaiting_content -> value_gated (assess returns "fail") - terminal
 *   generating -> skipped (decide returns "skip" or "wait") - terminal
 *   generating|awaiting_content -> failed (permanent fault) - terminal
 *
 * Failure classification (step: honest failure modes):
 *   Permanent - cannot succeed on retry, goes straight to 'failed' with the
 *   reason in brain_reasoning, visible in the dashboard Approvals screen:
 *     - provider resolution failure (no llm_configs row, missing/mismatched
 *       ENCRYPTION_KEY, undecryptable config)
 *     - LLM call rejected with a 4xx other than 429 (bad key, unknown model,
 *       malformed request): 400/401/403/404/422
 *   Transient - left at the current status for reap, which retries with a
 *   ceiling (MAX_RETRY_COUNT) and then marks 'failed': network errors, 429,
 *   5xx, invalid LLM output, CAS races, process crashes.
 *
 * 'failed', 'value_gated' and 'skipped' are terminal and are NOT recovered
 * by reap. A generation_failed message can be re-queued by the operator via
 * POST /v1/messages/:id/retry after the configuration fault is fixed.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { renderMarkdownToHtml, markdownToText } from "@claros/brain-oss";
import { pendingApprovalBatch } from "@claros/core";
import {
  decide,
  draft,
  assess,
  type DecidePromptContext,
  type DraftPromptContext,
} from "@claros/brain-oss";
import { resolveTenantProvider, overLlmBudget } from "./provider-resolver.js";
import { assembleContext } from "./context-assembler.js";
import { applyBudgetForBothPaths, draftContextToDecideContext, checkAssessBudget } from "./context-budget.js";
import { renderTemplate, renderLenient, type TemplateContext } from "./template-renderer.js";
import { fetchStepContext, contextSection } from "./context-fetch.js";
import { selectKbEntry, pinnedKbSection } from "./kb-select.js";
import { draftOpening } from "@claros/brain-oss";
import type { CompiledStep } from "@claros/core";
import { runChoose } from "./choose.js";

/** A template with this slot gets an AI opening line (G29). */
const OPENING_SLOT = /\{\{\s*brain\.opening/;
import { applyTextRules, findDisallowedLinks, textRuleObjects, textRuleStrings, trackedDomains } from "./draft-checks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** A candidate message claimed from the content generation batch query. */
export interface ContentCandidate {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  membershipId: string;
  flowStepOrder: number | null;
  brainActionType: string | null;
  /** Action type forced by a regenerate request (G20); decide is skipped when set. */
  forcedActionType?: string | null;
  /**
   * Revise: a reviewer's instruction. The draft on the row is rewritten to
   * apply it; decide and the value gate are skipped (a person is reviewing).
   */
  revisionRequest?: string | null;
  /** The draft under revision (subject and plain text), when revising. */
  previousSubject?: string | null;
  previousBodyText?: string | null;
}

/** The part of the drafting instruction that asks for a revision of the previous draft. */
export function revisionInstruction(candidate: Pick<ContentCandidate, "revisionRequest" | "previousSubject" | "previousBodyText">): string {
  return [
    "REVISION REQUEST: a reviewer read the previous draft of this email and asked for changes.",
    "Rewrite the previous draft so it applies the reviewer's feedback. Keep what the feedback does not ask to change.",
    "Every other rule still holds: use only the links and facts given here, and write in the same language.",
    "",
    `PREVIOUS SUBJECT: ${candidate.previousSubject ?? ""}`,
    "PREVIOUS BODY:",
    candidate.previousBodyText ?? "",
    "",
    "REVIEWER FEEDBACK:",
    candidate.revisionRequest ?? "",
  ].join("\n");
}

/** Stats returned by processContentTick for observability. */
export interface ContentTickResult {
  claimed: number;
  advanced: number;
  skipped: number;
  valueGated: number;
  /** Permanent failures terminally marked 'failed' this tick. */
  failed: number;
  errors: number;
  /** Messages put back because the product's daily LLM budget is spent (P5b). */
  deferred: number;
  /** LLM calls (decide, draft, assess) and their failures per product this tick. */
  llmCalls: Record<string, LlmCallStats>;
}

/** LLM calls made for messages and how many failed (transient or permanent). */
export interface LlmCallStats {
  calls: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Batch claim (FOR UPDATE SKIP LOCKED + CAS in a single CTE)
// ---------------------------------------------------------------------------

/**
 * Claims a batch of pending_generation messages atomically.
 *
 * Uses a CTE with FOR UPDATE SKIP LOCKED to:
 *   1. Select eligible messages without blocking on rows another worker holds
 *   2. Atomically set their status to 'generating' in the same statement
 *
 * This guarantees two concurrent content workers get completely disjoint sets.
 * The claim (status = 'generating') happens inside the same SQL statement as
 * the lock, so no window exists between fetch and claim.
 *
 * Sort order: tenant_id ASC, created_at ASC (FIFO within tenant, round-robin
 * across tenants by natural ordering). Unlike drain, there is no flow_class or
 * priority ordering - the Brain processes all pending messages in FIFO order.
 *
 * Tenant scoping: only messages for the specified tenants are eligible. If
 * tenantIds is empty, no messages are claimed.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param batchLimit - Max messages to claim per tick.
 * @param tenantIds - Tenant IDs to scope the claim to. Empty = no-op.
 */
export async function claimContentBatch(
  db: Db,
  now: Date,
  batchLimit: number,
  tenantIds: string[],
): Promise<ContentCandidate[]> {
  if (tenantIds.length === 0) return [];

  // The claim (FOR UPDATE SKIP LOCKED + status = 'generating') is one statement
  // inside the Store; see WorkerContentQueries.claimContentBatch.
  return storeFor(db).workerContent.claimContentBatch({ now, limit: batchLimit, tenantIds });
}

// ---------------------------------------------------------------------------
// Content tick processor
// ---------------------------------------------------------------------------

/**
 * Process a single content generation tick. Called by the pg-boss handler.
 *
 * Finds all tenants with pending_generation messages, claims a batch, and
 * processes each message through the decide -> draft -> render pipeline.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param batchLimit - Max messages per tick (default 20).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed (skips the global discovery query). When omitted, all
 *   tenants with pending_generation messages are discovered and processed
 *   (production default).
 */
export async function processContentTick(
  db: Db,
  now: Date,
  batchLimit: number = 20,
  tenantIds?: string[],
): Promise<ContentTickResult> {
  const stats: ContentTickResult = {
    claimed: 0,
    advanced: 0,
    skipped: 0,
    valueGated: 0,
    failed: 0,
    errors: 0,
    deferred: 0,
    llmCalls: {},
  };

  // Step 1: Determine target tenants - use provided list or discover globally.
  let resolvedTenantIds: string[];
  if (tenantIds && tenantIds.length > 0) {
    resolvedTenantIds = tenantIds;
  } else {
    const pendingTenantIds = await storeFor(db).workerContent.listTenantsWithPendingGeneration();

    if (pendingTenantIds.length === 0) return stats;
    resolvedTenantIds = pendingTenantIds;
  }

  // Step 2: Claim batch atomically.
  const candidates = await claimContentBatch(db, now, batchLimit, resolvedTenantIds);
  stats.claimed = candidates.length;

  if (candidates.length === 0) return stats;

  // Step 3: Process each claimed message.
  for (const candidate of candidates) {
    const llm = (stats.llmCalls[candidate.tenantId] ??= { calls: 0, errors: 0 });
    const outcome = await processOneContentMessage(db, candidate, now, llm);
    switch (outcome) {
      case "advanced":
        stats.advanced++;
        break;
      case "skipped":
        stats.skipped++;
        break;
      case "value_gated":
        stats.valueGated++;
        break;
      case "failed":
        stats.failed++;
        break;
      case "error":
        stats.errors++;
        break;
      case "deferred":
        stats.deferred++;
        break;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

/** deferred (P5b): the product's daily LLM budget is spent; the message waits (status_reason llm_budget). */
export type ContentOutcome = "advanced" | "skipped" | "value_gated" | "failed" | "error" | "deferred";

/**
 * HTTP statuses from the LLM provider that no retry can fix: the key is
 * invalid, the model does not exist, or the request shape is rejected.
 * 429 and 5xx are deliberately excluded (transient).
 */
const PERMANENT_LLM_STATUSES = new Set([400, 401, 403, 404, 422]);

function isPermanentLlmFailure(statusCode: number | null | undefined): boolean {
  return statusCode != null && PERMANENT_LLM_STATUSES.has(statusCode);
}

/**
 * Terminally fail a claimed message, recording the reason where the
 * dashboard surfaces it. CAS from the expected status; a lost race means
 * another actor moved the row and this failure no longer applies.
 */
async function failPermanently(
  db: Db,
  candidate: ContentCandidate,
  fromStatus: "generating" | "awaiting_content",
  reason: string,
  now: Date,
): Promise<ContentOutcome> {
  // P5b: message.failed also on content-generation failures.
  const won = await storeFor(db).workerContent.markFailed(
    candidate.id,
    fromStatus,
    `generation_failed: ${reason}`,
    now,
    { tenantId: candidate.tenantId, outbox: [{ event: "message.failed", payload: { message_id: candidate.id, reason: "generation_failed" } }] },
  );
  if (!won) {
    return "error";
  }
  console.error(
    `[content] message ${candidate.id} (tenant ${candidate.tenantId}) ` +
      `permanently failed: ${reason}`,
  );
  return "failed";
}

/**
 * Process a single claimed message through the full Brain pipeline:
 *   1. Resolve the tenant's LLM provider.
 *   2. Call decide() - branch on the action.
 *   3. If "contact": advance to awaiting_content, call draft(), render
 *      markdown, write subject + body_html + body_text, advance to
 *      pending_approval.
 *   4. If "skip" or "wait": mark as 'skipped' with reasoning.
 *
 * CAS on every write ensures concurrent actors (reap, another content worker)
 * cannot corrupt state.
 *
 * Failure path: permanent faults (no provider, 4xx auth/model errors) go
 * straight to 'failed' with the reason recorded; transient faults leave the
 * message at its current status for reap recovery with a retry ceiling.
 */
export async function processOneContentMessage(
  db: Db,
  candidate: ContentCandidate,
  now: Date,
  llm?: LlmCallStats,
): Promise<ContentOutcome> {
  /** Count one LLM call and whether it failed (for the LLM error-rate alert). */
  const countCall = (ok: boolean) => {
    if (!llm) return;
    llm.calls++;
    if (!ok) llm.errors++;
  };
  try {
    // 1. Assemble the full context packet (needed for both template and LLM paths).
    const assembled = await assembleContext(db, candidate, now);
    if (assembled === null) {
      // Contact not found - data integrity issue. Leave at generating for reap.
      return "error";
    }

    // 1b. Template path: if the step carries a template_ref, render the
    // template deterministically without any LLM calls. decide, draft, and
    // assess are all skipped because:
    //   - decide: template content is pre-authored, the decision to contact
    //     was already made by the flow author placing the step in the plan.
    //   - draft: the template IS the content; there is nothing to generate.
    //   - assess: pre-authored content is the operator's responsibility and
    //     does not need an automated quality gate.
    // 1a. Render facts of the product (links, guidelines, locale, data sources).
    const info = await storeFor(db).workerContent.getRenderInfo({ tenantId: candidate.tenantId, flowId: candidate.flowId });
    const extras: RenderExtras = { links: productLinks(info?.settings), context: undefined };
    const step = assembled.step;
    // P5b: {{event.*}}, the properties of the event that enrolled the contact.
    extras.event = await storeFor(db).workerContent.getMembershipTriggerProperties({ tenantId: candidate.tenantId, membershipId: candidate.membershipId });
    // P5b: the daily LLM token budget. A message that needs the LLM waits
    // (back to pending_generation, status_reason llm_budget) until the next UTC day.
    const needsLlm = step?.type === "choose" || !assembled.templateRef;
    if (needsLlm && (await overLlmBudget(db, candidate.tenantId, info?.settings, now))) {
      return deferForBudget(db, candidate, now);
    }
    /** What this message is drafted from: the step, or the candidate a choose step picked. */
    const eff: {
      context?: CompiledStep["context"];
      on_empty?: CompiledStep["on_empty"];
      on_error?: CompiledStep["on_error"];
      kb_select?: CompiledStep["kb_select"];
      template_ref?: string;
      brain_instruction?: string;
      action_type: string;
      allowed_links?: string[];
    } = {
      context: step?.context,
      on_empty: step?.on_empty,
      on_error: step?.on_error,
      kb_select: step?.kb_select,
      template_ref: assembled.templateRef,
      brain_instruction: assembled.draftCtx.brain_instruction,
      action_type: candidate.brainActionType ?? "nurture_value",
      allowed_links: step?.allowed_links,
    };
    let chosen = false;

    // 1a'. choose step (G27): deterministic filters, then the LLM picks one
    // eligible candidate or none.
    if (step?.type === "choose" && info) {
      const contact = await storeFor(db).workerContent.getTemplateContact(candidate.tenantId, candidate.contactId);
      if (contact === null) return "error";
      const r = await runChoose(db, {
        tenantId: candidate.tenantId,
        contactId: candidate.contactId,
        flowId: candidate.flowId,
        messageId: candidate.id,
        stepOrder: candidate.flowStepOrder ?? 1,
        step,
        settings: info.settings,
        product: info.tenantSlug,
        flowSlug: info.flowSlug,
        flowClass: info.flowClass,
        contact: { external_id: contact.external_id, email: contact.email, traits: contact.properties ?? {} },
        // A revision keeps the action the draft was written for.
        forcedActionType: candidate.forcedActionType ?? (candidate.revisionRequest ? candidate.brainActionType : null),
        now,
        provider: async () => {
          const pr = await resolveTenantProvider(db, candidate.tenantId);
          return pr.ok ? pr.provider : { error: pr.reason };
        },
        draftCtx: {
          ...assembled.draftCtx,
          ...(productGuidelines(info.settings) ? { guidelines: productGuidelines(info.settings) } : {}),
          ...(info.locale ? { locale: info.locale } : {}),
        },
        countCall,
      });
      const decided = {
        tenantId: candidate.tenantId,
        outbox: [{ event: "choose.decided", payload: { message_id: candidate.id, choice: r.decision.choice, reason: r.decision.reason } }],
      };
      if (r.kind === "llm_error") {
        if (isPermanentLlmFailure(r.statusCode)) return failPermanently(db, candidate, "generating", `choose: ${r.error}`, now);
        return "error";
      }
      if (r.kind === "none") {
        await storeFor(db).workerContent.saveMessageMeta({ tenantId: candidate.tenantId, messageId: candidate.id, meta: { chooseDecision: r.decision }, events: decided });
        const won = await storeFor(db).workerContent.markSkipped(candidate.id, `choose: none (${r.decision.reason})`, now);
        return won ? "skipped" : "error";
      }
      const c = r.pick.candidate;
      await storeFor(db).workerContent.saveMessageMeta({
        tenantId: candidate.tenantId,
        messageId: candidate.id,
        meta: {
          chooseDecision: r.decision,
          actionType: c.action_type,
          ...(r.pick.snapshot ? { contextSnapshot: r.pick.snapshot } : {}),
          ...(r.pick.kbEntry ? { kbEntryId: r.pick.kbEntry.id } : {}),
        },
        events: decided,
      });
      eff.context = undefined;
      eff.kb_select = undefined;
      eff.template_ref = c.template_ref;
      eff.brain_instruction = c.brain_instruction ?? step.brain_instruction;
      eff.action_type = c.action_type;
      if (c.allowed_links) eff.allowed_links = c.allowed_links;
      if (r.pick.snapshot) extras.context = r.pick.snapshot;
      if (r.pick.kbEntry) extras.kb = { title: r.pick.kbEntry.title, content: r.pick.kbEntry.content };
      chosen = true;
    }

    // 1b. Context-fetch hook (G11): call the step's data sources first.
    if (eff.context && eff.context.length > 0 && info) {
      const contact = await storeFor(db).workerContent.getTemplateContact(candidate.tenantId, candidate.contactId);
      if (contact === null) return "error";
      const r = await fetchStepContext({
        settings: info.settings,
        product: info.tenantSlug,
        contact: { external_id: contact.external_id, email: contact.email, traits: contact.properties ?? {} },
        flowSlug: info.flowSlug,
        stepOrder: candidate.flowStepOrder ?? 1,
        messageId: candidate.id,
        entries: eff.context,
        now,
      });
      if (!r.ok) {
        const mode = eff.on_error ?? "defer";
        if (mode === "fail") return failPermanently(db, candidate, "generating", `context_error: ${r.error}`, now);
        if (mode === "skip") {
          const won = await storeFor(db).workerContent.markSkipped(candidate.id, `context_error: ${r.error}`, now);
          return won ? "skipped" : "error";
        }
        // defer: leave the message at 'generating'; reap retries it later.
        console.warn(`[content] message ${candidate.id}: context deferred: ${r.error}`);
        return "error";
      }
      await storeFor(db).workerContent.saveMessageMeta({ tenantId: candidate.tenantId, messageId: candidate.id, meta: { contextSnapshot: r.snapshot } });
      if (r.empty && (eff.on_empty ?? "send") === "skip") {
        const won = await storeFor(db).workerContent.markSkipped(candidate.id, `context_empty: ${r.emptySources.join(", ")}`, now);
        return won ? "skipped" : "error";
      }
      extras.context = r.snapshot;
    }

    // 1c. Knowledge base selection (G18): the entry this message is about.
    if (eff.kb_select) {
      const contact = await storeFor(db).workerContent.getTemplateContact(candidate.tenantId, candidate.contactId);
      if (contact === null) return "error";
      const entry = await selectKbEntry(db, {
        tenantId: candidate.tenantId,
        contactId: candidate.contactId,
        messageId: candidate.id,
        select: eff.kb_select,
        traits: contact.properties ?? {},
        query: `${eff.brain_instruction ?? ""} ${eff.action_type}`,
      });
      if (!entry) {
        const won = await storeFor(db).workerContent.markSkipped(candidate.id, `kb_exhausted: no unused entry in category '${eff.kb_select.category}'`, now);
        return won ? "skipped" : "error";
      }
      await storeFor(db).workerContent.saveMessageMeta({ tenantId: candidate.tenantId, messageId: candidate.id, meta: { kbEntryId: entry.id } });
      extras.kb = { title: entry.title, content: entry.content };
    }

    // P5b: allowed_links narrows the named links (and the link allowlist) to these names.
    const restricted = eff.allowed_links !== undefined;
    if (restricted) {
      const all = extras.links ?? {};
      extras.links = Object.fromEntries(Object.entries(all).filter(([name]) => eff.allowed_links!.includes(name)));
    }

    if (eff.template_ref) {
      return processTemplateMessage(db, candidate, eff.template_ref, now, extras, {
        draftCtx: {
          ...assembled.draftCtx,
          ...(productGuidelines(info?.settings) ? { guidelines: productGuidelines(info?.settings) } : {}),
          ...(info?.locale ? { locale: info.locale } : {}),
        },
        settings: info?.settings ?? {},
        countCall,
      });
    }

    // 2. Resolve tenant's LLM provider. A resolution failure is always a
    // configuration fault (no llm_configs row, bad ENCRYPTION_KEY, or an
    // undecryptable envelope): no amount of retrying generates content, so
    // the message fails terminally with the reason instead of looping.
    const providerResult = await resolveTenantProvider(db, candidate.tenantId);
    if (!providerResult.ok) {
      return failPermanently(db, candidate, "generating", providerResult.reason, now);
    }
    const { provider } = providerResult;

    // 3. Apply dual-path budget truncation.
    // The budget step measures both the decide and draft assembled messages
    // to ensure both fit within MAX_CONTEXT_TOKENS. If budget estimation is
    // not available (e.g., buildDraftMessages not loaded), the un-truncated
    // context is used - the LLM handles slight overruns gracefully.
    let decideCtx: DecidePromptContext = assembled.decideCtx;
    let draftCtx: DraftPromptContext = chosen
      ? { ...assembled.draftCtx, action_type: eff.action_type, brain_instruction: eff.brain_instruction }
      : assembled.draftCtx;
    try {
      const actionType = eff.action_type;
      const truncResult = applyBudgetForBothPaths(
        draftCtx,
        actionType,
        assembled.lastSeen,
      );
      draftCtx = truncResult.ctx;
      decideCtx = draftContextToDecideContext(truncResult.ctx, actionType, assembled.lastSeen);

      if (truncResult.droppedSections.length > 0) {
        console.info(
          `[content] message ${candidate.id}: budget truncation dropped ` +
            `[${truncResult.droppedSections.join(", ")}]`,
        );
      }
    } catch {
      // Budget estimation unavailable (buildDraftMessages/buildDecideMessages
      // not loaded). Use the un-truncated contexts as-is. This path is hit
      // only in test environments where @claros/brain-oss is mocked.
    }

    // 3a. Knowledge base (G18): pinned entries always, the selected entry when kb_select picked one.
    const pinned = await pinnedKbSection(db, candidate.tenantId);
    if (pinned) draftCtx = { ...draftCtx, pinned_kb: pinned };
    if (extras.kb) draftCtx = { ...draftCtx, selected_kb: `## ${extras.kb.title}\n${extras.kb.content}` };

    // 3a'. Product voice and limits (G19, G22): named links, writing rules,
    // guidelines (within a budget) and the drafting language.
    {
      const guidelines = productGuidelines(info?.settings);
      draftCtx = {
        ...draftCtx,
        ...(Object.keys(extras.links ?? {}).length > 0 ? { allowed_links: extras.links } : {}),
        ...(textRuleStrings(info?.settings).length > 0 || step?.single_cta
          ? { text_rules: [...textRuleStrings(info?.settings), ...(step?.single_cta ? [SINGLE_CTA_RULE] : [])] }
          : {}),
        ...(guidelines ? { guidelines } : {}),
        ...(info?.locale ? { locale: info.locale } : {}),
      };
    }

    // 3b. Context data (G11) and brain instruction variables.
    if (extras.context) {
      draftCtx = { ...draftCtx, external_context: contextSection(extras.context) };
      decideCtx = { ...decideCtx, kbContext: [decideCtx.kbContext, `CONTEXT DATA:\n${contextSection(extras.context, 2000)}`].filter(Boolean).join("\n\n") };
    }
    if (draftCtx.brain_instruction && /\{\{/.test(draftCtx.brain_instruction)) {
      const contact = await storeFor(db).workerContent.getTemplateContact(candidate.tenantId, candidate.contactId);
      if (contact) {
        draftCtx = {
          ...draftCtx,
          brain_instruction: renderLenient(draftCtx.brain_instruction, {
            contact: { first_name: contact.first_name, last_name: contact.last_name, email: contact.email, external_id: contact.external_id, properties: contact.properties },
            tenant: { name: info?.tenantName ?? "" },
            flow: { name: info?.flowName ?? "" },
            context: extras.context,
            links: extras.links,
            event: extras.event,
          }),
        };
      }
    }

    // 3c. Revise: the previous draft and the reviewer's feedback, added after
    // budget truncation and variable rendering so neither alters them.
    if (candidate.revisionRequest) {
      draftCtx = {
        ...draftCtx,
        brain_instruction: [draftCtx.brain_instruction, revisionInstruction(candidate)].filter(Boolean).join("\n\n"),
      };
    }

    // 4. Call decide(), unless a reviewer forced the action type (G20
    // regenerate) or asked for a revision: the decision to contact was then
    // taken by a person.
    let decision: { action: string; reasoning?: string | null };
    if (candidate.revisionRequest) {
      decision = { action: "contact", reasoning: `Revised at a reviewer's request: ${candidate.revisionRequest}` };
    } else if (candidate.forcedActionType) {
      decision = { action: "contact", reasoning: `forced action: ${candidate.forcedActionType}` };
    } else if (chosen) {
      // The choose step already decided to contact with this action.
      decision = { action: "contact", reasoning: `choose: ${eff.action_type}` };
    } else {
      const decideResult = await decide(provider, decideCtx);
      countCall(decideResult.ok);
      if (!decideResult.ok) {
        if (isPermanentLlmFailure(decideResult.statusCode)) {
          return failPermanently(db, candidate, "generating", `decide: ${decideResult.error}`, now);
        }
        // Transient LLM error or invalid output - leave at generating for reap.
        return "error";
      }
      decision = decideResult.decision;
    }

    // 4b. Branch on decision
    if (decision.action === "skip" || decision.action === "wait") {
      // Terminal: mark as skipped with reasoning.
      const reasoning = decision.reasoning
        ? `${decision.action}: ${decision.reasoning}`
        : decision.action;

      const skipWon = await storeFor(db).workerContent.markSkipped(candidate.id, reasoning, now);

      if (!skipWon) {
        // CAS failed - another actor moved the row.
        return "error";
      }

      return "skipped";
    }

    // decision.action === "contact" - proceed to draft.

    // 5. Advance to awaiting_content (CAS: must still be at generating)
    const awaitWon = await storeFor(db).workerContent.markAwaitingContent(
      candidate.id,
      decision.reasoning ?? null,
      now,
    );

    if (!awaitWon) {
      // CAS failed - another actor moved the row.
      return "error";
    }

    // 6. Call draft()
    const draftResult = await draft(provider, draftCtx);
    countCall(draftResult.ok);
    if (!draftResult.ok) {
      if (isPermanentLlmFailure(draftResult.statusCode)) {
        return failPermanently(db, candidate, "awaiting_content", `draft: ${draftResult.error}`, now);
      }
      // Transient LLM error or invalid output - leave at awaiting_content for reap.
      return "error";
    }

    let { subject, body_markdown } = draftResult.draft;

    // 6b. Post-draft checks (G19): text rules, then the link allowlist.
    {
      const ruled = applyTextRules(textRuleObjects(info?.settings), { subject, body: body_markdown });
      subject = ruled.subject;
      body_markdown = ruled.body;
      const blocked = async (statusReason: string, reasoning: string): Promise<ContentOutcome> => {
        const won = await storeFor(db).workerContent.markBlocked({
          messageId: candidate.id,
          fromStatus: "awaiting_content",
          statusReason,
          reasoning,
          body: { subject, bodyHtml: renderMarkdownToHtml(body_markdown), bodyText: markdownToText(body_markdown) },
          now,
        });
        return won ? "failed" : "error";
      };
      if (ruled.forbidden.length > 0) {
        return blocked("text_rule_forbidden", `text_rule_forbidden: the draft contains ${ruled.forbidden.map((f) => JSON.stringify(f)).join(", ")}`);
      }
      // The allowlist is on once the product declares links or tracked
      // domains; without either, drafts keep the v0.6 behaviour.
      // allowed_links (P5b): only the step's named links (and context URLs), no other tracked-domain URL.
      const domains = restricted ? [] : trackedDomains(info?.settings);
      const allowlistOn = restricted || Object.keys(extras.links ?? {}).length > 0 || domains.length > 0;
      const bad = allowlistOn
        ? findDisallowedLinks(`${subject}\n${body_markdown}`, { links: extras.links ?? {}, trackedDomains: domains, context: extras.context })
        : [];
      if (bad.length > 0) {
        return blocked("link_not_allowed", `link_not_allowed: ${bad.join(", ")}`);
      }
      // single_cta (P5b): at most one link (the footer and unsubscribe links are added at send time).
      if (step?.single_cta) {
        const links = distinctLinks(`${subject}\n${body_markdown}`);
        if (links.length > 1) return blocked("single_cta", `single_cta: the draft has ${links.length} links (${links.join(", ")})`);
      }
    }

    // 7. Assess budget: check the assess call fits after the actual draft body
    // is known. No re-truncation (would create incoherence); just a warning.
    checkAssessBudget(draftCtx, subject, body_markdown);

    // 8. Value gate: assess the draft for quality before pending_approval.
    //
    // A 'fail' verdict terminates the message at 'value_gated' (draft preserved
    // for audit). A gate call error leaves the message at 'awaiting_content' for
    // reap - it is NOT marked value_gated. Only a validated 'fail' verdict gates.
    // P5b: settings.brain.assess: enabled false skips the gate; threshold asks for a score.
    // A revision skips the gate: the reviewer asked for it and reviews it.
    const assessCfg = candidate.revisionRequest ? { enabled: false, threshold: null } : assessSettings(info?.settings);
    const assessResult = assessCfg.enabled
      ? await assess(provider, { draftCtx, subject, body_markdown, ...(assessCfg.threshold ? { threshold: assessCfg.threshold } : {}) })
      : ({ ok: true, assessment: { verdict: "pass", reasoning: "value gate disabled" } } as const);
    if (assessCfg.enabled) countCall(assessResult.ok);

    if (!assessResult.ok) {
      if (isPermanentLlmFailure(assessResult.statusCode)) {
        return failPermanently(db, candidate, "awaiting_content", `assess: ${assessResult.error}`, now);
      }
      // Gate call error (transient LLM failure, parse failure).
      // Leave at awaiting_content for reap; do NOT mark value_gated.
      return "error";
    }

    if (assessResult.assessment.verdict === "fail") {
      // Render the draft body for storage even though it won't be approved:
      // the draft content is preserved on the row for audit.
      const bodyHtml = renderMarkdownToHtml(body_markdown);
      const bodyText = markdownToText(body_markdown);
      const gateReasoning = `value_gated: ${assessResult.assessment.reasoning}`;

      const gatedWon = await storeFor(db).workerContent.markValueGated(
        candidate.id,
        { subject, bodyHtml, bodyText },
        gateReasoning,
        now,
      );

      if (!gatedWon) {
        // CAS failed - another actor moved the row.
        return "error";
      }

      return "value_gated";
    }

    // assessResult.assessment.verdict === "pass" - proceed to pending_approval (or approved).

    // 9. Render markdown to HTML and derive plain text
    const bodyHtml = renderMarkdownToHtml(body_markdown);
    const bodyText = markdownToText(body_markdown);

    // 9b. Check flow's approval_mode to determine target status.
    // If the flow has approval_mode = 'auto', skip pending_approval and go
    // directly to 'approved'. This avoids blocking auto-approved flows on
    // human review while preserving the default require-approval path.
    const approvalMode = (await storeFor(db).workerContent.getFlowApprovalMode(candidate.flowId)) ?? "require";
    const targetStatus = approvalMode === "auto" ? "approved" : "pending_approval";
    const approvedAt = approvalMode === "auto" ? now : null;

    // 10. Write content and advance to target status (CAS: awaiting_content)
    const finalWon = await storeFor(db).workerContent.completeDraft(
      candidate.id,
      targetStatus,
      { subject, bodyHtml, bodyText },
      approvedAt,
      now,
      queueEvents(candidate, targetStatus, now),
    );

    if (!finalWon) {
      // CAS failed - another actor moved the row.
      return "error";
    }

    return "advanced";
  } catch {
    // On any error, leave the message at its current status for reap recovery.
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Template rendering path (no LLM calls)
// ---------------------------------------------------------------------------

/**
 * Process a template-bearing message: resolve the template from the DB,
 * render it with variable interpolation, and advance directly to
 * pending_approval or approved (per flow's approval_mode).
 *
 * Skips decide, draft, and assess entirely:
 *   - decide: the flow author placed this step in the plan; the decision
 *     to contact is implicit in the template reference.
 *   - draft: the template IS the content.
 *   - assess: pre-authored content is the operator's responsibility.
 *
 * On render failure (missing variables, template not found), the message
 * is permanently failed with a clear reason.
 */
async function processTemplateMessage(
  db: Db,
  candidate: ContentCandidate,
  templateSlug: string,
  now: Date,
  extras: RenderExtras = {},
  ai?: { draftCtx: DraftPromptContext; settings: Record<string, unknown>; countCall: (ok: boolean) => void },
): Promise<ContentOutcome> {
  // 1. Look up the template by slug + tenant
  const template = await storeFor(db).workerContent.getActiveTemplate(candidate.tenantId, templateSlug);

  if (template === null) {
    return failPermanently(
      db,
      candidate,
      "generating",
      `template_not_found: no active template with slug "${templateSlug}" for this tenant`,
      now,
    );
  }

  // 2. Build template context from the candidate's contact/tenant/flow data
  const contact = await storeFor(db).workerContent.getTemplateContact(candidate.tenantId, candidate.contactId);

  if (contact === null) {
    return "error"; // Contact not found - integrity issue
  }

  const tenantName = (await storeFor(db).workerContent.getTenantName(candidate.tenantId)) ?? "Unknown";

  const flowName = (await storeFor(db).workerContent.getFlowName(candidate.flowId)) ?? "Unknown";

  // G29: a {{brain.opening}} slot gets one AI-drafted opening line; fixed
  // templates without the slot make no LLM call.
  if (ai && OPENING_SLOT.test(`${template.subject}\n${template.body_html}\n${template.body_text ?? ""}`)) {
    if (await overLlmBudget(db, candidate.tenantId, ai.settings, now)) return deferForBudget(db, candidate, now);
    const providerResult = await resolveTenantProvider(db, candidate.tenantId);
    if (!providerResult.ok) return failPermanently(db, candidate, "generating", providerResult.reason, now);
    const r = await draftOpening(providerResult.provider, { ctx: ai.draftCtx, templateSubject: template.subject, templateBody: template.body_html });
    ai.countCall(r.ok);
    if (!r.ok) {
      if (isPermanentLlmFailure(r.statusCode)) return failPermanently(db, candidate, "generating", `opening: ${r.error}`, now);
      return "error";
    }
    const ruled = applyTextRules(textRuleObjects(ai.settings), { subject: "", body: r.value.opening });
    const opening = ruled.body.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
    if (ruled.forbidden.length > 0) {
      const won = await storeFor(db).workerContent.markBlocked({
        messageId: candidate.id,
        fromStatus: "generating",
        statusReason: "text_rule_forbidden",
        reasoning: `text_rule_forbidden: the opening line contains ${ruled.forbidden.map((f) => JSON.stringify(f)).join(", ")}`,
        body: { subject: template.subject, bodyHtml: opening, bodyText: opening },
        now,
      });
      return won ? "failed" : "error";
    }
    await storeFor(db).workerContent.saveMessageMeta({ tenantId: candidate.tenantId, messageId: candidate.id, meta: { openingLine: opening } });
    extras = { ...extras, brain: { ...(extras.brain ?? {}), opening } };
  }

  const ctx: TemplateContext = {
    contact: {
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      external_id: contact.external_id,
      properties: contact.properties,
    },
    tenant: { name: tenantName },
    flow: { name: flowName },
    context: extras.context,
    links: extras.links,
    brain: extras.brain,
    kb: extras.kb,
    event: extras.event,
  };

  // 3. Render the template
  const renderResult = renderTemplate(
    template.subject,
    template.body_html,
    template.body_text,
    ctx,
  );

  if (!renderResult.ok) {
    return failPermanently(
      db,
      candidate,
      "generating",
      `template_render_failed: ${renderResult.reason}`,
      now,
    );
  }

  // 4. Determine target status based on flow's approval_mode
  const approvalMode = (await storeFor(db).workerContent.getFlowApprovalMode(candidate.flowId)) ?? "require";
  const targetStatus = approvalMode === "auto" ? "approved" : "pending_approval";
  const approvedAt = approvalMode === "auto" ? now : null;

  // 5. Write rendered content and advance status (CAS: generating)
  const finalWon = await storeFor(db).workerContent.completeTemplate(
    candidate.id,
    targetStatus,
    {
      subject: renderResult.subject,
      bodyHtml: renderResult.bodyHtml,
      bodyText: renderResult.bodyText,
    },
    approvedAt,
    candidate.revisionRequest
      ? `template_rendered: ${templateSlug} (a template step is not revised by the AI: edit the draft or the template)`
      : "template_rendered: " + templateSlug,
    now,
    queueEvents(candidate, targetStatus, now),
  );

  if (!finalWon) {
    return "error"; // CAS failed
  }

  return "advanced";
}

export { renderMarkdownToHtml, markdownToText };

/** Values a message is rendered with besides the contact (G11, G19, G29). */
export interface RenderExtras {
  context?: Record<string, unknown>;
  links?: Record<string, string>;
  brain?: { opening?: string };
  kb?: { title: string; content: string };
  /** P5b: the triggering event's properties ({{event.*}}). */
  event?: Record<string, unknown> | null;
}

/** Writing rule given to the model for single_cta steps (P5b). */
export const SINGLE_CTA_RULE = "Use at most one link in the whole email: a single call to action.";

/** Distinct http(s) URLs in a draft (markdown links and bare URLs), trailing punctuation dropped. */
export function distinctLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
  return [...out];
}

/** settings.brain.assess (P5b): enabled (default true) and an optional score threshold (1-10). */
export function assessSettings(settings: Record<string, unknown> | null | undefined): { enabled: boolean; threshold: number | null } {
  const a = (settings?.brain as { assess?: { enabled?: unknown; threshold?: unknown } } | undefined)?.assess;
  const threshold = typeof a?.threshold === "number" && a.threshold >= 1 && a.threshold <= 10 ? Math.round(a.threshold) : null;
  return { enabled: a?.enabled !== false, threshold };
}

/** Put a claimed message back to pending_generation with status_reason llm_budget (P5b). */
async function deferForBudget(db: Db, candidate: ContentCandidate, now: Date): Promise<ContentOutcome> {
  const won = await storeFor(db).workerContent.releaseForBudget(candidate.id, now);
  return won ? "deferred" : "error";
}

/** Most characters of settings.brain.guidelines given to the model (about 3,000 tokens). */
export const GUIDELINES_MAX_CHARS = 12_000;

/** settings.brain.guidelines within the budget, or undefined. */
export function productGuidelines(settings: Record<string, unknown> | null | undefined): string | undefined {
  const g = (settings?.brain as { guidelines?: unknown } | undefined)?.guidelines;
  if (typeof g !== "string" || g.trim() === "") return undefined;
  return g.length > GUIDELINES_MAX_CHARS ? `${g.slice(0, GUIDELINES_MAX_CHARS)}\n(guidelines truncated)` : g;
}

/** The product's named links (settings.links), or {}. */
export function productLinks(settings: Record<string, unknown> | null | undefined): Record<string, string> {
  const raw = settings?.links;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * Outbox entry for a message entering the approval queue (G14): the
 * batched message.pending_approval event, at most one per product and
 * endpoint per 15-minute window.
 */
function queueEvents(candidate: ContentCandidate, targetStatus: string, now: Date) {
  if (targetStatus !== "pending_approval") return undefined;
  const batch = pendingApprovalBatch(now);
  return {
    tenantId: candidate.tenantId,
    outbox: [{ event: "message.pending_approval", payload: { message_id: candidate.id }, dedupKey: batch.dedupKey, deliverAt: batch.deliverAt, batched: true }],
  };
}
