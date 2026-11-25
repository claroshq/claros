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
import { marked, Renderer, Lexer, type Token, type Tokens } from "marked";
import {
  decide,
  draft,
  assess,
  type DecidePromptContext,
  type DraftPromptContext,
} from "@claros/brain-oss";
import { resolveTenantProvider } from "./provider-resolver.js";
import { assembleContext } from "./context-assembler.js";
import { applyBudgetForBothPaths, draftContextToDecideContext, checkAssessBudget } from "./context-budget.js";
import { renderTemplate, type TemplateContext } from "./template-renderer.js";

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
    const outcome = await processOneContentMessage(db, candidate, now);
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
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

export type ContentOutcome = "advanced" | "skipped" | "value_gated" | "failed" | "error";

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
  const won = await storeFor(db).workerContent.markFailed(
    candidate.id,
    fromStatus,
    `generation_failed: ${reason}`,
    now,
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
): Promise<ContentOutcome> {
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
    if (assembled.templateRef) {
      return processTemplateMessage(db, candidate, assembled.templateRef, now);
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
    let draftCtx: DraftPromptContext = assembled.draftCtx;
    try {
      const actionType = candidate.brainActionType ?? "nurture_value";
      const truncResult = applyBudgetForBothPaths(
        assembled.draftCtx,
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

    // 4. Call decide()
    const decideResult = await decide(provider, decideCtx);
    if (!decideResult.ok) {
      if (isPermanentLlmFailure(decideResult.statusCode)) {
        return failPermanently(db, candidate, "generating", `decide: ${decideResult.error}`, now);
      }
      // Transient LLM error or invalid output - leave at generating for reap.
      return "error";
    }

    const { decision } = decideResult;

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
    if (!draftResult.ok) {
      if (isPermanentLlmFailure(draftResult.statusCode)) {
        return failPermanently(db, candidate, "awaiting_content", `draft: ${draftResult.error}`, now);
      }
      // Transient LLM error or invalid output - leave at awaiting_content for reap.
      return "error";
    }

    const { subject, body_markdown } = draftResult.draft;

    // 7. Assess budget: check the assess call fits after the actual draft body
    // is known. No re-truncation (would create incoherence); just a warning.
    checkAssessBudget(draftCtx, subject, body_markdown);

    // 8. Value gate: assess the draft for quality before pending_approval.
    //
    // A 'fail' verdict terminates the message at 'value_gated' (draft preserved
    // for audit). A gate call error leaves the message at 'awaiting_content' for
    // reap - it is NOT marked value_gated. Only a validated 'fail' verdict gates.
    const assessResult = await assess(provider, {
      draftCtx,
      subject,
      body_markdown,
    });

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
    "template_rendered: " + templateSlug,
    now,
  );

  if (!finalWon) {
    return "error"; // CAS failed
  }

  return "advanced";
}

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters to entity references.
 * Used to neutralise raw HTML that passes through the marked token pipeline.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return true for URL schemes that are safe to render as href/src values.
 * Rejects javascript:, data:, vbscript:, and any other non-HTTP schemes.
 */
function isSafeUrl(url: string): boolean {
  return (
    /^(?:https?|mailto):/i.test(url) ||
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith(".")
  );
}

/**
 * Build a marked Renderer that disables raw HTML passthrough and blocks
 * dangerous URL schemes in link/image href attributes.
 *
 * marked v18 produces one token type for all raw HTML, regardless of position:
 * block-level HTML (e.g. a bare <script> tag) and inline HTML inside a
 * paragraph, list item, or link text all produce a token of type "html" with
 * a "block" boolean field distinguishing them. The renderer's html() method is
 * invoked for both. Overriding it once is sufficient to cover every path.
 *
 * The only other attribute values that marked's renderer writes from markdown
 * input are: href/src (overridden below), and title/alt (escaped by marked's
 * internal O() function which encodes & < > " ' to entity references, making
 * attribute boundary escape impossible). No post-render string pass is needed.
 */
/**
 * Build a marked Renderer that produces email-safe, inline-styled HTML.
 *
 * Security overrides:
 *   1. html(): all raw HTML tokens are escaped to entity references.
 *   2. link()/image(): dangerous URL schemes are replaced with safe fallbacks.
 *
 * Email-safe overrides:
 *   - Paragraphs, headings, lists, blockquotes, code blocks, and horizontal
 *     rules all carry inline styles suitable for email rendering.
 *   - No class names, no external CSS references.
 *   - Font sizes and spacing designed to look good inside the email shell's
 *     15px/1.6 body content area.
 *
 * Allowed markdown constructs:
 *   - Paragraphs, bold, italic, strikethrough
 *   - Headings (h1-h3 only; h4-h6 rendered as h3)
 *   - Ordered and unordered lists
 *   - Links (http/https only)
 *   - Images (http/https only, max-width constrained)
 *   - Blockquotes
 *   - Code (inline and fenced blocks)
 *   - Horizontal rules
 *
 * Stripped/escaped:
 *   - Raw HTML (any tag the model emits becomes visible text)
 *   - Dangerous URL schemes (javascript:, data:, vbscript:, etc.)
 *   - Tables (complex layout, unreliable in email clients)
 */
function buildSafeRenderer(): Renderer {
  const renderer = new Renderer();

  // Escape all raw HTML tokens (block and inline) to entity references.
  // This covers: <script>, <iframe>, <img onerror=...>, inline <b onclick=...>,
  // and any other tag the model emits, wherever it appears in the document.
  renderer.html = ({ raw }: { raw: string }): string => escapeHtml(raw);

  // Paragraphs: standard spacing for email
  renderer.paragraph = ({ tokens }: { tokens: Token[] }): string => {
    const body = renderer.parser.parseInline(tokens);
    return `<p style="margin:0 0 16px 0;line-height:1.6;">${body}</p>\n`;
  };

  // Headings: only h1-h3, all others become h3
  renderer.heading = ({ tokens, depth }: { tokens: Token[]; depth: number }): string => {
    const body = renderer.parser.parseInline(tokens);
    const level = Math.min(depth, 3);
    const styles: Record<number, string> = {
      1: "font-size:22px;font-weight:700;margin:0 0 16px 0;line-height:1.3;",
      2: "font-size:18px;font-weight:600;margin:0 0 12px 0;line-height:1.3;",
      3: "font-size:16px;font-weight:600;margin:0 0 10px 0;line-height:1.4;",
    };
    return `<h${level} style="${styles[level]}">${body}</h${level}>\n`;
  };

  // Lists: inline padding for email
  renderer.list = (token: Tokens.List): string => {
    const tag = token.ordered ? "ol" : "ul";
    const startAttr = token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : "";
    const style = "margin:0 0 16px 0;padding-left:24px;";
    const itemsHtml = token.items.map((item) => renderer.listitem(item)).join("");
    return `<${tag}${startAttr} style="${style}">\n${itemsHtml}</${tag}>\n`;
  };

  renderer.listitem = (item: Tokens.ListItem): string => {
    const body = renderer.parser.parse(item.tokens);
    return `<li style="margin:0 0 6px 0;line-height:1.5;">${body}</li>\n`;
  };

  // Blockquotes: left border with padding
  renderer.blockquote = ({ tokens }: Tokens.Blockquote): string => {
    const body = renderer.parser.parse(tokens);
    return `<blockquote style="margin:0 0 16px 0;padding:12px 16px;border-left:3px solid #d1d5db;color:#4b5563;">${body}</blockquote>\n`;
  };

  // Code blocks: monospace background
  renderer.code = ({ text, lang }: { text: string; lang?: string }): string => {
    void lang;
    return `<pre style="margin:0 0 16px 0;padding:12px 16px;background-color:#f3f4f6;border-radius:6px;overflow-x:auto;"><code style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;line-height:1.5;color:#1f2937;">${escapeHtml(text)}</code></pre>\n`;
  };

  // Inline code
  renderer.codespan = ({ text }: { text: string }): string => {
    return `<code style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;padding:2px 5px;background-color:#f3f4f6;border-radius:3px;">${text}</code>`;
  };

  // Horizontal rule
  renderer.hr = (): string => {
    return `<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;" />\n`;
  };

  // Images: constrained width for email safety
  renderer.image = ({ href, title, text }: Tokens.Image): string => {
    const safeHref = isSafeUrl(href ?? "") ? href : "";
    if (!safeHref) return "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || "")}"${titleAttr} style="max-width:100%;height:auto;display:block;margin:0 0 16px 0;border:0;" />`;
  };

  // Links: safe URL with accent color
  renderer.link = ({ href, title, tokens }: Tokens.Link): string => {
    const safeHref = isSafeUrl(href ?? "") ? href : "#";
    const body = renderer.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttr} style="color:#2563eb;text-decoration:underline;">${body}</a>`;
  };

  // Tables: strip entirely (unreliable in email clients, and the model
  // should not be producing tabular data in lifecycle emails)
  renderer.table = (): string => "";
  renderer.tablerow = (): string => "";
  renderer.tablecell = (): string => "";

  return renderer;
}

/**
 * Render markdown string to sanitised HTML.
 *
 * Security model: `body_markdown` is model-generated text. Although the draft
 * prompt requests markdown-only output, there is no schema-level enforcement
 * preventing the model from emitting HTML (script tags, event handlers,
 * iframes, javascript: hrefs). Two renderer-level overrides handle this:
 *
 *   1. html() override: all raw HTML tokens - block and inline - are escaped
 *      to entity references. Model-emitted tags become visible text, not
 *      markup. This covers every position: bare block tags, tags mid-paragraph,
 *      tags inside list items, and tags inside link or image text.
 *   2. link/image overrides: hrefs using non-HTTP schemes (javascript:, data:,
 *      vbscript:, ...) are replaced with safe fallbacks ('#' for links, '' for
 *      images).
 *
 * No post-render string pass is applied. All dangerous content originates from
 * raw HTML tokens (handled by override 1) or href values (handled by override
 * 2). marked's own renderer encodes title and alt attribute values with its
 * internal escape function (& < > " ' -> entities), so no attribute boundary
 * escape is possible from those paths.
 *
 * Normal markdown constructs (headings, bold, italic, lists, code, links with
 * https:// hrefs) are rendered to HTML unchanged.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const renderer = buildSafeRenderer();
  return marked.parse(markdown, { async: false, renderer }) as string;
}

// ---------------------------------------------------------------------------
// Plain-text derivation (from markdown source, not from rendered HTML)
// ---------------------------------------------------------------------------

/**
 * Decode the small set of HTML entities that marked encodes in token text
 * fields (it only encodes &, <, >, ", ' in text nodes).
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Recursively convert a marked token list to a plain-text string.
 *
 * Design choices:
 * - Derived from the markdown token tree, not from rendered HTML, so raw
 *   HTML blocks in the source are discarded rather than partially stripped.
 * - Links: rendered as "text (url)" so the URL survives in the plain-text
 *   version (important for email clients that render the text/plain part).
 * - Lists: unordered items get a "- " prefix; ordered items get "N. ".
 * - Headings: text only, no "#" markers - headings are structurally a
 *   paragraph boundary in plain-text email.
 * - Code blocks: content preserved verbatim.
 * - Raw HTML tokens (type "html"): discarded entirely.
 */
function tokensToText(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "paragraph":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "strong":
      case "em":
      case "del":
        out += tokensToText(token.tokens ?? []);
        break;

      case "text":
        // text tokens can have sub-tokens (e.g., inside a list item)
        if (token.tokens && token.tokens.length > 0) {
          out += tokensToText(token.tokens);
        } else {
          out += decodeEntities(token.text);
        }
        break;

      case "link": {
        const linkText = tokensToText(token.tokens ?? []);
        if (token.href && token.href !== linkText) {
          out += `${linkText} (${token.href})`;
        } else {
          out += linkText;
        }
        break;
      }

      case "image":
        if (token.href) {
          out += `${token.text} (${token.href})`;
        } else {
          out += token.text;
        }
        break;

      case "list": {
        for (let i = 0; i < token.items.length; i++) {
          const item = token.items[i]!;
          const prefix = token.ordered ? `${(token.start as number) + i}. ` : "- ";
          out += prefix + tokensToText(item.tokens ?? []).trim() + "\n";
        }
        out += "\n";
        break;
      }

      case "blockquote": {
        const quoted = tokensToText(token.tokens ?? []).trim();
        out +=
          quoted
            .split("\n")
            .map((l) => (l ? "> " + l : ">"))
            .join("\n") + "\n\n";
        break;
      }

      case "code":
        out += token.text + "\n\n";
        break;

      case "codespan":
        out += token.text;
        break;

      case "br":
        out += "\n";
        break;

      case "hr":
        out += "---\n\n";
        break;

      case "html":
        // Discard raw HTML blocks in plain text output.
        break;

      case "space":
        // Blank lines between blocks are handled by the "\n\n" each block emits.
        break;

      default:
        // Unknown token type: fall back to sub-tokens if present, then text.
        if ("tokens" in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
          out += tokensToText((token as { tokens: Token[] }).tokens);
        } else if ("text" in token && typeof (token as { text?: string }).text === "string") {
          out += decodeEntities((token as { text: string }).text);
        }
    }
  }
  return out;
}

/**
 * Derive a plain-text version of the email body from the original markdown
 * source.
 *
 * Deriving from markdown rather than from rendered HTML avoids re-processing
 * any HTML the model may have injected - those tokens are simply discarded.
 * The result is suitable for the text/plain MIME part of the outgoing email.
 *
 * Link targets are preserved as "(url)" suffixes so recipients using
 * plain-text clients still have the URLs. List structure uses "- " (unordered)
 * or "N. " (ordered) prefixes. Heading levels are collapsed to plain text
 * paragraph boundaries.
 */
export function markdownToText(markdown: string): string {
  const tokens = Lexer.lex(markdown);
  return tokensToText(tokens)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

