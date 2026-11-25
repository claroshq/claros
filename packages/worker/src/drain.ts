/**
 * Drain worker - picks up approved messages and hands them to transport.
 *
 * Scheduled every drain_interval_minutes (default 15 min) via pg-boss cron.
 * Selects approved messages ordered by flow_class (critical first), then
 * priority DESC, then FIFO. Uses FOR UPDATE SKIP LOCKED for safe concurrency
 * across multiple drain workers.
 *
 * Processing order per message:
 *   1. Resolve transport adapter for the tenant.
 *      - If null (no transport configured): skip, message stays approved.
 *   2. Claim the message (status = 'sending') via CAS.
 *   3. Resolve tenant postal address (required for CAN-SPAM compliance).
 *      - If absent: revert to 'approved' and log operator error. Not a transport
 *        failure; no retry count consumed. No throttle budget consumed (check
 *        runs before the throttle gate).
 *   4. Verify UNSUBSCRIBE_SIGNING_KEY is configured.
 *      - If absent: revert to 'approved' and log operator error. Same treatment
 *        as a missing postal address - configuration fault, not transport fault.
 *        No retry count consumed, no throttle budget consumed.
 *   4b. Verify BASE_URL is usable in production (not localhost/loopback, https,
 *       parseable). If unusable: revert to 'approved' and log operator error.
 *       Same treatment as 3 and 4 - configuration fault, not transport fault.
 *       No retry consumed, no throttle budget consumed. This check is more
 *       critical than either of the above: a wrong BASE_URL is permanently
 *       baked into delivered email bodies and cannot be corrected. Outside
 *       production the check is suppressed (quickstart depends on localhost).
 *   5. Evaluate the throttle gate.
 *      - allow: hand to transport.
 *      - suppress: mark as 'suppressed' (terminal).
 *      - defer_frequency / defer_window: revert to 'approved' with scheduled_send_at.
 *   6. Write recipient_address = contact email (before send).
 *      The unsubscribe endpoint uses this column together with status = 'sent'
 *      to confirm delivery. Writing it before the send covers the crash window:
 *      if the process dies after the provider accepts the message but before
 *      the post-send DB write, the address is still present once reap recovers
 *      the row to 'sent'. The column is NOT a send confirmation by itself.
 *   7. Generate compliance headers and footer. Inject footer into bodies.
 *      The stored message row is NOT updated - the injected footer is ephemeral.
 *   8. On transport success: mark 'sent', record sent_at, write provider_message_id.
 *   9. On transport permanent failure: mark 'failed' immediately (not left for reap).
 *  10. On transport transient failure: message stays at 'sending' for reap to retry.
 *
 * NOTE: After task 14, the drain sends nothing in any real deployment. The
 * transport resolver returns null until Phase 4 builds real adapters (tasks
 * 26-32b). Messages that pass the throttle gate remain at 'approved' and are
 * re-evaluated each tick. "Drain implemented" means scheduling, batch
 * selection, throttle evaluation, and transport seam are wired - not
 * "email works."
 *
 * NOTE: On transient transport failure, message remains at 'sending'. Recovery
 * is handled by the reap worker (task 15), which finds messages stuck in
 * 'sending' for > REAP_STUCK_THRESHOLD_HOURS and either retries
 * (retry_count < MAX_RETRY_COUNT) or marks failed. On permanent transport
 * failure (sendResult.permanent = true), the drain marks the message failed
 * immediately without waiting for reap.
 *
 * Per-tenant fairness (Cloud-only, EDITIONS.md):
 *   Community is single-tenant, so the simple batch query suffices.
 *   The fetchDrainBatch strategy parameter allows Cloud to substitute a
 *   round-robin implementation without forking this file. Cloud passes a
 *   different FetchDrainBatch function at startup via apps/server wiring.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  evaluateThrottleGate,
  resolveThrottleConfig,
  wrapInShell,
  wrapInTextShell,
  buildShellComplianceHtml,
  buildShellComplianceText,
  type BrandSettings,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "@claros/core";
import type { TransportAdapter, TransportResolver } from "./transport.js";
import {
  buildComplianceOutput,
  checkBaseUrl,
  resolveBaseUrl,
  productLinkBaseUrl,
  resolveSigningKey,
} from "./compliance.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** A candidate message selected from the drain batch query. */
export interface DrainCandidate {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  flowStepOrder: number | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  retryCount: number | null;
}

/** Strategy for fetching a batch of drain candidates. */
export type FetchDrainBatch = (
  db: Db,
  now: Date,
  globalLimit: number,
  tenantIds: string[],
) => Promise<DrainCandidate[]>;

/** Stats returned by processdrainTick for observability. */
export interface DrainTickResult {
  candidatesFetched: number;
  skippedNoTransport: number;
  skippedNoEmail: number;
  /** Messages skipped because the tenant has no postal address configured. */
  skippedNoPostalAddress: number;
  /** Messages skipped because UNSUBSCRIBE_SIGNING_KEY is not set. */
  skippedNoSigningKey: number;
  /**
   * Messages skipped because BASE_URL is unusable in production (localhost,
   * non-https, or unparseable). Configuration fault, not transport fault.
   * No retry consumed. The wrong value would be permanently baked into the
   * unsubscribe link of every delivered email.
   */
  skippedBadBaseUrl: number;
  sent: number;
  suppressed: number;
  deferredFrequency: number;
  deferredWindow: number;
  /** Transient transport failures (message stays at 'sending' for reap). */
  transportErrors: number;
  /** Permanent transport failures (message immediately marked 'failed'). */
  permanentFailures: number;
}

// ---------------------------------------------------------------------------
// Default batch fetcher (Community: simple priority + FIFO)
// ---------------------------------------------------------------------------

/**
 * Fetches a batch of approved messages ready to send, atomically claiming them.
 *
 * Uses a CTE with FOR UPDATE SKIP LOCKED to:
 *   1. Select eligible messages without blocking on rows another worker holds
 *   2. Atomically set their status to 'sending' in the same statement
 *
 * This guarantees two concurrent drain workers get completely disjoint sets.
 * The claim (status = 'sending') happens inside the same SQL statement as
 * the lock, so no window exists between fetch and claim.
 *
 * Sort order (from spec S7, explicit encoding):
 *   1. flow_class: critical before nurture (a nurture flow with priority 100
 *      never jumps ahead of a critical flow with priority 1).
 *   2. flow priority DESC (within the same class).
 *   3. created_at ASC (FIFO within same class + priority).
 *
 * Messages are eligible when:
 *   - status = 'approved'
 *   - scheduled_send_at is null (never deferred) or <= now (defer period elapsed)
 */
export const fetchDrainBatchSimple: FetchDrainBatch = async (
  db: Db,
  now: Date,
  globalLimit: number,
  tenantIds: string[],
): Promise<DrainCandidate[]> => {
  if (tenantIds.length === 0) return [];

  // The claim (FOR UPDATE SKIP LOCKED + status = 'sending') is one statement
  // inside the Store; see WorkerDrainQueries.claimDrainBatch.
  return storeFor(db).workerDrain.claimDrainBatch({ now, limit: globalLimit, tenantIds });
};

// ---------------------------------------------------------------------------
// Drain tick processor
// ---------------------------------------------------------------------------

/**
 * Process a single drain tick. Called by the pg-boss handler.
 *
 * Transport resolution happens BEFORE any messages are claimed. If a tenant
 * has no transport configured, its messages are never touched - no claim,
 * no revert, zero writes. This means that today (before Phase 4), a drain
 * tick performs zero writes to lifecycle_messages.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param resolveTransport - Resolves a TransportAdapter for a tenant.
 * @param fetchBatch - Strategy for selecting messages (default: simple priority+FIFO).
 * @param batchLimit - Max messages per tick (default from throttle config is per-tenant,
 *   but for Community single-tenant this is effectively global).
 * @param baseUrlOverride - Base URL override for tests. Production reads BASE_URL env.
 * @param signingKeyOverride - Signing key override for tests. Production reads UNSUBSCRIBE_SIGNING_KEY env.
 * @param isProductionOverride - Production flag override for tests. Production reads NODE_ENV env.
 *   When true, checkBaseUrl enforces the no-localhost / https-required rules even in test environments.
 *   When false, checkBaseUrl allows any URL. Defaults to NODE_ENV === 'production'.
 */
export async function processDrainTick(
  db: Db,
  now: Date,
  resolveTransport: TransportResolver,
  fetchBatch: FetchDrainBatch = fetchDrainBatchSimple,
  batchLimit: number = 50,
  baseUrlOverride?: string,
  signingKeyOverride?: string,
  isProductionOverride?: boolean,
): Promise<DrainTickResult> {
  const stats: DrainTickResult = {
    candidatesFetched: 0,
    skippedNoTransport: 0,
    skippedNoEmail: 0,
    skippedNoPostalAddress: 0,
    skippedNoSigningKey: 0,
    skippedBadBaseUrl: 0,
    sent: 0,
    suppressed: 0,
    deferredFrequency: 0,
    deferredWindow: 0,
    transportErrors: 0,
    permanentFailures: 0,
  };

  // Step 1: Find tenants that have approved messages ready to drain.
  // This is a cheap read-only query (no locks, no writes).
  const dueTenantIds = await storeFor(db).workerDrain.listTenantsWithDueMessages(now);

  if (dueTenantIds.length === 0) return stats;

  // Step 2: Resolve transport for each tenant. Only proceed with tenants
  // that have a configured adapter. This is the gate that ensures zero
  // writes when no transport exists (the normal state before Phase 4).
  const tenantsWithTransport = new Map<string, TransportAdapter>();
  for (const dueTenantId of dueTenantIds) {
    const adapter = await resolveTransport(dueTenantId);
    if (adapter !== null) {
      tenantsWithTransport.set(dueTenantId, adapter);
    } else {
      stats.skippedNoTransport++;
    }
  }

  if (tenantsWithTransport.size === 0) return stats;

  // Step 3: Fetch and claim messages only for tenants with transport.
  // The batch query atomically sets status = 'sending' (FOR UPDATE SKIP LOCKED).
  const tenantIds = Array.from(tenantsWithTransport.keys());
  const candidates = await fetchBatch(db, now, batchLimit, tenantIds);
  stats.candidatesFetched = candidates.length;

  if (candidates.length === 0) return stats;

  // Step 3b: Resolve daily_limit for each tenant
  const tenantDailyLimits = new Map<string, number | null>();
  for (const tenantId of tenantIds) {
    tenantDailyLimits.set(tenantId, await storeFor(db).workerDrain.getTransportDailyLimit(tenantId));
  }

  // Count sent messages today per tenant (for daily limit enforcement)
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tenantSentToday = new Map<string, number>();
  for (const tenantId of tenantIds) {
    tenantSentToday.set(tenantId, await storeFor(db).workerDrain.countSentSince(tenantId, startOfDay));
  }

  const baseUrl = resolveBaseUrl(baseUrlOverride);

  // Step 4: Process each claimed message.
  for (const candidate of candidates) {
    const adapter = tenantsWithTransport.get(candidate.tenantId)!;

    // Check daily limit before processing
    const dailyLimit = tenantDailyLimits.get(candidate.tenantId) ?? null;
    const sentToday = tenantSentToday.get(candidate.tenantId) ?? 0;
    if (dailyLimit !== null && sentToday >= dailyLimit) {
      // Revert to approved, will retry tomorrow
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await storeFor(db).workerDrain.deferClaim(candidate.id, tomorrow, now);
      continue;
    }

    const result = await processOneMessage(db, candidate, now, adapter, baseUrl, signingKeyOverride, isProductionOverride);
    switch (result) {
      case "no_email":
        stats.skippedNoEmail++;
        break;
      case "no_postal_address":
        stats.skippedNoPostalAddress++;
        break;
      case "no_signing_key":
        stats.skippedNoSigningKey++;
        break;
      case "bad_base_url":
        stats.skippedBadBaseUrl++;
        break;
      case "sent":
        stats.sent++;
        // Update the in-memory daily send counter so the next message in
        // this same tick sees the updated count and the limit is honoured
        // across the full batch, not just at the start of the tick.
        tenantSentToday.set(
          candidate.tenantId,
          (tenantSentToday.get(candidate.tenantId) ?? 0) + 1,
        );
        break;
      case "suppressed":
        stats.suppressed++;
        break;
      case "deferred_frequency":
        stats.deferredFrequency++;
        break;
      case "deferred_window":
        stats.deferredWindow++;
        break;
      case "transport_error":
        stats.transportErrors++;
        break;
      case "permanent_failure":
        stats.permanentFailures++;
        break;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

export type MessageOutcome =
  | "no_email"
  | "no_postal_address"
  | "no_signing_key"
  | "bad_base_url"
  | "sent"
  | "suppressed"
  | "deferred_frequency"
  | "deferred_window"
  | "transport_error"
  | "permanent_failure";

export async function processOneMessage(
  db: Db,
  candidate: DrainCandidate,
  now: Date,
  adapter: TransportAdapter,
  baseUrl: string,
  signingKeyOverride?: string,
  isProductionOverride?: boolean,
): Promise<MessageOutcome> {
  // Messages arrive here already at status = 'sending' (claimed by fetchBatch).
  // Transport is already resolved (per-tenant, before claiming).

  // Step 1: Fetch contact email. If no email, revert to approved.
  const contactRow = await storeFor(db).workerDrain.getContact(candidate.contactId);

  if (contactRow === null || !contactRow.email) {
    await revertToApproved(db, candidate.id, now);
    return "no_email";
  }

  const contactEmail = contactRow.email;
  const contactProps = contactRow.properties as Record<string, unknown> | null;
  const contactTimezone = (contactProps?.timezone as string) ?? null;

  // Step 2: Resolve tenant postal address and brand settings.
  // If postal address is absent, revert the message to 'approved' and surface
  // an operator error. This is NOT a transport failure - the message is not
  // broken, the tenant configuration is incomplete. No retry count consumed.
  const tenantSettings = await resolveTenantDrainSettings(db, candidate.tenantId);
  const postalAddress = tenantSettings?.postalAddress ?? null;
  if (!postalAddress) {
    console.error(
      `[drain] tenant ${candidate.tenantId} has no postal_address in settings. ` +
        `Message ${candidate.id} cannot be sent without a CAN-SPAM compliant postal address. ` +
        `Configure tenants.settings.postal_address to unblock sending.`,
    );
    await revertToApproved(db, candidate.id, now);
    return "no_postal_address";
  }

  // Step 3: Verify UNSUBSCRIBE_SIGNING_KEY is configured.
  // A missing key is a configuration fault, not a transport fault - treated
  // identically to a missing postal address: revert to 'approved', no retry
  // consumed, operator-facing log error. Nothing may send without a valid key.
  const signingKey = resolveSigningKey(signingKeyOverride);
  if (signingKey === null) {
    console.error(
      `[drain] UNSUBSCRIBE_SIGNING_KEY is not set. ` +
        `Message ${candidate.id} (tenant ${candidate.tenantId}) cannot be sent without a signing key for unsubscribe tokens. ` +
        `Set UNSUBSCRIBE_SIGNING_KEY to unblock sending.`,
    );
    await revertToApproved(db, candidate.id, now);
    return "no_signing_key";
  }

  // Step 3b: Verify BASE_URL is usable in production.
  //
  // A localhost/loopback, non-https, or unparseable BASE_URL is a configuration
  // fault more serious than either of the above: the wrong value would be
  // permanently baked into the List-Unsubscribe header and unsubscribe link
  // footer of every delivered email and cannot be corrected retroactively.
  //
  // Treatment is identical to the other two configuration faults: revert to
  // 'approved', no retry consumed, operator-facing log error. Nothing sends.
  //
  // Outside production (NODE_ENV !== 'production') the check is suppressed so
  // the self-host quickstart (http://localhost:3000) continues to work.
  // Links in a product's mail use its public host when it has one.
  const linkBaseUrl = productLinkBaseUrl(baseUrl, tenantSettings?.publicHost);
  const baseUrlFault = checkBaseUrl(linkBaseUrl, isProductionOverride);
  if (baseUrlFault !== null) {
    console.error(
      `[drain] BASE_URL is unusable in production: ${baseUrlFault} ` +
        `Message ${candidate.id} (tenant ${candidate.tenantId}) will not be sent. ` +
        `This is not a transport failure and no retry is consumed. Fix BASE_URL to unblock sending.`,
    );
    await revertToApproved(db, candidate.id, now);
    return "bad_base_url";
  }

  // Step 4: Gather throttle gate inputs and evaluate.
  // Configuration checks (postal address, signing key) run before this gate
  // so a misconfigured tenant does not consume any throttle budget on each tick.
  const gateInput = await buildThrottleGateInput(
    db,
    candidate,
    contactEmail,
    contactTimezone,
    now,
  );

  const verdict = evaluateThrottleGate(gateInput);

  // Step 5: Act on verdict.
  switch (verdict.outcome) {
    case "suppress":
      // CAS: only write if the row is still at 'sending'. If reap concurrently
      // reverted it to 'approved' or 'failed', this update hits 0 rows and the
      // reap outcome wins (correct: reap ran first, drain was too slow).
      await storeFor(db).workerDrain.markSuppressed(candidate.id, now);
      return "suppressed";

    case "defer_frequency":
      // CAS: same guard as suppress. See comment above.
      await storeFor(db).workerDrain.deferClaim(candidate.id, verdict.retryAfter, now);
      return "deferred_frequency";

    case "defer_window":
      // CAS: same guard as suppress. See comment above.
      await storeFor(db).workerDrain.deferClaim(candidate.id, verdict.retryAfter, now);
      return "deferred_window";

    case "allow":
      break; // Fall through to transport
  }

  // Step 6: Resolve sender info.
  const senderInfo = await resolveSenderInfo(db, candidate.tenantId);

  // Step 7: Build compliance headers and footer.
  // signingKey is already confirmed non-null (checked in Step 3).
  const compliance = buildComplianceOutput({
    tenantId: candidate.tenantId,
    messageId: candidate.id,
    postalAddress,
    baseUrl: linkBaseUrl,
    signingKey,
  });

  // Step 8: Wrap body in branded email shell with compliance footer.
  // The shell is the complete HTML document; compliance is structural, placed
  // inside the shell footer. Stored row is NOT modified.
  const shellComplianceHtml = buildShellComplianceHtml(compliance.unsubscribeUrl, postalAddress);
  const shellComplianceText = buildShellComplianceText(compliance.unsubscribeUrl, postalAddress);

  const tenantName = tenantSettings?.tenantName ?? "Our Team";
  const brand = tenantSettings?.brand ?? {};

  const deliveredHtml = wrapInShell({
    bodyHtml: candidate.bodyHtml ?? "",
    brand,
    tenantName,
    complianceFooterHtml: shellComplianceHtml,
  });
  const deliveredText = wrapInTextShell({
    bodyText: candidate.bodyText ?? "",
    brand,
    tenantName,
    complianceFooterText: shellComplianceText,
  });

  // Step 9: Write recipient_address BEFORE sending.
  //
  // recipient_address records the address this message was prepared to send to.
  // Writing it here, before the adapter call, covers the crash window where the
  // process dies after the provider accepts the message but before the post-send
  // DB write completes. When reap later recovers the row to 'sent', the
  // unsubscribe endpoint can resolve the address correctly.
  //
  // NOTE: recipient_address being non-null is NOT a send confirmation. The
  // unsubscribe endpoint requires status = 'sent' in addition to this column
  // being set. A message at status = 'sending' or 'failed' with recipient_address
  // set was not successfully delivered and must not be treated as such.
  //
  // CAS: includes status = 'sending' so that if reap has already moved the row
  // while this message was being processed, this write hits 0 rows and the reap
  // outcome wins. In that case the send below will also have its status write hit
  // 0 rows, and the message is safely retried by reap.
  await storeFor(db).workerDrain.setRecipientAddress(candidate.id, contactEmail, now);

  // Step 10: Send via transport.
  try {
    const sendResult = await adapter.send({
      to: contactEmail,
      from: senderInfo.fromEmail,
      fromName: senderInfo.fromName ?? undefined,
      subject: candidate.subject ?? "(no subject)",
      bodyHtml: deliveredHtml,
      bodyText: deliveredText,
      messageId: candidate.id,
      headers: {
        "List-Unsubscribe": compliance.listUnsubscribeHeader,
        "List-Unsubscribe-Post": compliance.listUnsubscribePostHeader,
      },
    });

    if (sendResult.success) {
      // CAS: only mark sent if the row is still at 'sending'. If reap reverted
      // it to 'approved' (or 'failed') while a slow transport call was in flight,
      // this update hits 0 rows. The reap outcome wins; the contact gets a retry.
      //
      // recipient_address was already written before the send (Step 9). This write
      // only updates status, sentAt, and providerMessageId.
      await storeFor(db).workerDrain.markSent(candidate.id, sendResult.providerMessageId ?? null, now);
      return "sent";
    } else if (sendResult.permanent === true) {
      // Permanent failure: mark failed immediately without waiting for reap.
      // CAS: same guard as suppress. If reap already moved the row, this hits
      // 0 rows and the reap outcome wins.
      await storeFor(db).workerDrain.markFailed(candidate.id, now);
      return "permanent_failure";
    } else {
      // Transient failure: message stays at 'sending'.
      // Recovery is handled by the reap worker (task 15), which finds messages
      // stuck in 'sending' for > REAP_STUCK_THRESHOLD_HOURS and either retries
      // (retry_count < MAX_RETRY_COUNT) or marks failed.
      return "transport_error";
    }
  } catch {
    // Transport threw (network error, timeout, etc.). This is always transient -
    // a thrown exception means no response was received, so we cannot know the
    // provider's intent. Message stays at 'sending' for reap to retry.
    return "transport_error";
  }
}

// ---------------------------------------------------------------------------
// Revert helper
// ---------------------------------------------------------------------------

/**
 * Reverts a message from 'sending' back to 'approved'. Used when the drain
 * cannot proceed (no transport, no email, no postal address) after the atomic
 * batch claim.
 *
 * CAS: includes status = 'sending' in the WHERE clause so that if reap has
 * already moved the row to 'failed' (or another terminal state) while drain
 * held it, this revert hits 0 rows and the reap outcome wins.
 */
async function revertToApproved(db: Db, messageId: string, now: Date): Promise<void> {
  await storeFor(db).workerDrain.releaseClaim(messageId, now);
}

// ---------------------------------------------------------------------------
// Throttle gate input builder
// ---------------------------------------------------------------------------

async function buildThrottleGateInput(
  db: Db,
  candidate: DrainCandidate,
  contactEmail: string,
  contactTimezone: string | null,
  now: Date,
): Promise<ThrottleGateInput> {
  // Check suppression (case-insensitive via functional index on lower(email)).
  // The index uq_suppressions_tenant_email_lower is keyed on lower(email), so
  // the query must use lower() on both sides to hit the index.
  const isSuppressed = await storeFor(db).workerDrain.isSuppressed(candidate.tenantId, contactEmail);

  // Get flow class and step window_policy
  const flowRow = await storeFor(db).workerDrain.getFlowThrottleInfo(candidate.flowId);

  let flowClass: "critical" | "nurture" = "nurture";
  let windowPolicy: "immediate" | "respect_window" = "respect_window";

  if (flowRow !== null) {
    flowClass = flowRow.flowClass === "critical" ? "critical" : "nurture";

    // Extract window_policy from the compiled step
    if (candidate.flowStepOrder !== null && flowRow.compiledPlan) {
      const plan = flowRow.compiledPlan as { steps?: Array<{ order: number; window_policy?: string }> };
      if (Array.isArray(plan.steps)) {
        const step = plan.steps.find((s) => s.order === candidate.flowStepOrder);
        if (step?.window_policy === "immediate") {
          windowPolicy = "immediate";
        }
      }
    }
  }

  // Get tenant throttle config
  const tenantSettings = (await storeFor(db).workerDrain.getTenantSettings(candidate.tenantId)) as
    | Record<string, unknown>
    | null;
  const config = resolveThrottleConfig(tenantSettings?.throttle ?? null);

  // Get recent send history for this contact
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const recentSends = await storeFor(db).workerDrain.getRecentSends(candidate.contactId, last24h, last7d);

  return {
    isSuppressed,
    flowClass,
    windowPolicy,
    config,
    recentSends,
    contactTimezone,
    now,
  };
}

// ---------------------------------------------------------------------------
// Sender info resolver
// ---------------------------------------------------------------------------

interface SenderInfo {
  fromEmail: string;
  fromName: string | null;
}

/**
 * Resolves the sender email/name for a tenant from the active transport_configs row.
 * Returns a localhost fallback if no row exists (should not be reached in production
 * because the transport resolver would have returned null first; tests may reach
 * this path when they provide an adapter without a transport_configs row).
 */
async function resolveSenderInfo(db: Db, tenantId: string): Promise<SenderInfo> {
  // Look up the active transport config for from address.
  const sender = await storeFor(db).workerDrain.getSender(tenantId);

  if (sender !== null) {
    return sender;
  }

  // Fallback: should not be reached in production (transport resolver
  // would have returned null). Tests may reach here if they provide an
  // adapter but no transport_configs row.
  return { fromEmail: "noreply@localhost", fromName: null };
}

// ---------------------------------------------------------------------------
// Tenant settings resolver (postal address + brand)
// ---------------------------------------------------------------------------

/**
 * Result from resolving tenant settings needed at drain time.
 * Combined query to avoid a second round-trip.
 */
interface TenantDrainSettings {
  postalAddress: string | null;
  tenantName: string;
  brand: BrandSettings;
  publicHost: string | null;
}

/**
 * Resolves tenant postal address, name, and brand settings in one query.
 * Used at drain time to assemble the email shell.
 */
async function resolveTenantDrainSettings(db: Db, tenantId: string): Promise<TenantDrainSettings | null> {
  const tenantRow = await storeFor(db).workerDrain.getTenant(tenantId);

  if (tenantRow === null) return null;

  const settings = tenantRow.settings as Record<string, unknown> | null;
  const addr = settings?.postal_address;
  const postalAddress = (typeof addr === "string" && addr.trim().length > 0)
    ? addr.trim()
    : null;

  const brand = (settings?.brand as BrandSettings | undefined) ?? {};

  return {
    postalAddress,
    tenantName: tenantRow.name,
    brand,
    publicHost: tenantRow.publicHost ?? null,
  };
}
