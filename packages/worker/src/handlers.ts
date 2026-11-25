/**
 * @claros/worker/handlers - job handlers and the runtime-neutral dispatcher.
 *
 * Importing this entry does not import pg-boss: the Cloudflare Workers
 * runtime (apps/worker) uses it with Cloudflare Queues, and the pg-boss
 * wiring in ./index.ts calls into the same runJob() from its work()
 * callbacks, so the job logic exists once.
 *
 * Exports:
 *   - runJob(name, data, deps): run one job of a queue (QUEUE.* in @claros/core).
 *     Follow-up jobs (trigger-check -> advance-membership -> process-message
 *     -> drain-message) go through deps.enqueue.
 *   - the handler functions and helpers that ./index.ts has always exported.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  QUEUE,
  isPeriodicJob,
  resolveThrottleConfig,
  type CompileJobData,
  type TriggerCheckJobData,
  type KbEmbedJobData,
  type AdvanceMembershipJobData,
  type ProcessMessageJobData,
  type DrainMessageJobData,
} from "@claros/core";
import { storeFor } from "@claros/store";
import { handleCompileJob } from "./compile.js";
import { handleKbEmbedJob } from "./embed-kb.js";
import { phaseTimeTransitions } from "./scan-time-transitions.js";
import { phaseEnrollment } from "./scan-enrollment.js";
import { phaseSegmentEnrollment } from "./scan-segment-enrollment.js";
import { phaseDateEnrollment } from "./date-flows.js";
import { phaseStepAdvancement } from "./scan-step-advancement.js";
import { phaseEngagementDepth } from "./scan-engagement-depth.js";
import { handleTriggerCheck } from "./trigger-check.js";
import { processDrainTick, fetchDrainBatchSimple } from "./drain.js";
import { processReapTick } from "./reap.js";
import { processCounterRollover } from "./counter-rollover.js";
import { processPartitionMaintenance } from "./partition-maintenance.js";
import { processContentTick } from "./content.js";
import { runApprovalsDigest } from "./approvals-digest.js";
import type { TransportResolver } from "./transport.js";
import { buildTenantTransportResolver } from "./transport-resolver.js";
import { handleAdvanceMembership } from "./advance-membership.js";
import { handleProcessMessage } from "./process-message.js";
import { handleDrainMessage } from "./drain-message.js";
import { processGridSnapshotTick } from "./snapshot-retention-grid.js";
import { processWebhookTick, type FetchFn } from "./webhooks.js";
import {
  checkSendErrors,
  recordDrainFaults,
  recordJobFailure,
  recordLlmCalls,
  recordTickRun,
  runAlertTick,
  runDigest,
} from "./alerts.js";

export { nullTransportResolver } from "./transport.js";
export type { TransportAdapter, TransportResolver, TransportSendResult, TransportSendParams } from "./transport.js";
export { buildTenantTransportResolver } from "./transport-resolver.js";
export { processDrainTick, fetchDrainBatchSimple, processOneMessage as processOneDrainMessage } from "./drain.js";
export type { FetchDrainBatch, DrainTickResult, DrainCandidate, DrainConfigFault, MessageOutcome } from "./drain.js";
export {
  recordOpsEvent,
  recordJobFailure,
  recordDeadLetter,
  recordTickRun,
  checkLateTicks,
  recordDrainFaults,
  checkSendErrors,
  recordLlmCalls,
  runAlertTick,
  runDigest,
  dueForMail,
  ALERT_SETTING,
  COUNTER_PREFIX,
} from "./alerts.js";
export type { OpsEventSpec, AlertDeliveryDeps, AlertTickResult, DigestResult } from "./alerts.js";
export {
  buildComplianceOutput,
  injectHtmlFooter,
  injectTextFooter,
  resolveBaseUrl,
  productLinkBaseUrl,
  resolveSigningKey,
  type ComplianceInput,
  type ComplianceOutput,
} from "./compliance.js";
export {
  wrapInShell,
  wrapInTextShell,
  buildShellComplianceHtml,
  buildShellComplianceText,
  type BrandSettings,
  type EmailShellInput,
  type TextShellInput,
} from "@claros/core";
export { processReapTick } from "./reap.js";
export { runApprovalsDigest, localDateHour, APPROVALS_DIGEST_HOUR } from "./approvals-digest.js";
export type { ReapTickResult } from "./reap.js";
export { processCounterRollover } from "./counter-rollover.js";
export type { CounterRolloverResult } from "./counter-rollover.js";
export { processPartitionMaintenance } from "./partition-maintenance.js";
export type { PartitionMaintenanceResult } from "./partition-maintenance.js";
export { processContentTick, claimContentBatch, processOneContentMessage } from "./content.js";
export type { ContentTickResult, ContentCandidate, ContentOutcome, LlmCallStats } from "./content.js";
export { handleTriggerCheck } from "./trigger-check.js";
export type { TriggerCheckResult } from "./trigger-check.js";
export { phaseStepAdvancement } from "./scan-step-advancement.js";
export { phaseDateEnrollment, cancelExpiredMessages, DATE_ENROLLMENT_CAP } from "./date-flows.js";
export type { PhaseDateEnrollmentResult } from "./date-flows.js";
export type { PhaseStepAdvancementResult } from "./scan-step-advancement.js";
export { handleAdvanceMembership } from "./advance-membership.js";
export type { AdvanceMembershipResult } from "./advance-membership.js";
export { handleProcessMessage } from "./process-message.js";
export type { ProcessMessageResult } from "./process-message.js";
export { handleDrainMessage } from "./drain-message.js";
export type { DrainMessageResult } from "./drain-message.js";
export { processGridSnapshotTick } from "./snapshot-retention-grid.js";
export { processWebhookTick, webhookBody, analyticsEvent, statsravenIngestUrl } from "./webhooks.js";
export type { WebhookTickDeps, WebhookTickResult, FetchFn } from "./webhooks.js";
export type { GridSnapshotResult } from "./snapshot-retention-grid.js";
export {
  renderTemplate,
  escapeHtml,
  SUPPORTED_VARIABLE_PREFIXES,
} from "./template-renderer.js";
export type { TemplateContext, TemplateRenderOutcome, RenderResult, RenderError } from "./template-renderer.js";
export { handleKbEmbedJob, EMBEDDING_MAX_CHARS, DEFAULT_EMBEDDING_MODEL } from "./embed-kb.js";
export { EmbeddingPermanentError, resolveEmbeddingProvider, callEmbedding } from "./embedding-client.js";
export { buildKbContextSection, KB_MAX_RESULTS, KB_SIMILARITY_FLOOR } from "./context-kb.js";
export { assembleContext } from "./context-assembler.js";
export type { AssembledContext } from "./context-assembler.js";
export {
  estimateTokens,
  estimateTokensFromMessages,
  estimateDecideTokens,
  estimateAssessTokens,
  checkAssessBudget,
  applyBudgetTruncation,
  applyBudgetForBothPaths,
  draftContextToDecideContext,
  MAX_CONTEXT_TOKENS,
} from "./context-budget.js";
export type { TruncationResult, DroppableSection } from "./context-budget.js";

type Db = NodePgDatabase<Record<string, never>>;

/** Enqueue a job: pg-boss send() on Node, a Queue send on Workers. */
export type EnqueueJob = (
  queue: string,
  data: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<unknown>;

/** What a job needs from its runtime. */
export interface JobDeps {
  /** Drizzle handle with its Store registered (Postgres or D1). */
  db: Db;
  /** Enqueue follow-up jobs. */
  enqueue: EnqueueJob;
  /**
   * Transport resolver for drain and drain-message jobs. When absent, each
   * job builds the tenant resolver from the database
   * (buildTenantTransportResolver), which reads transport_configs per call.
   */
  resolveTransport?: TransportResolver;
  /** HTTP client for webhook delivery (tests pass a fake). Default: global fetch. */
  fetch?: FetchFn;
}

/** Follow-up job options, as pg-boss reads them (Workers: see apps/worker). */
const CHAIN_OPTS = { retryLimit: 2, retryDelay: 10, expireInSeconds: 300 } as const;

/** Failures already recorded as ops events inside a job (not recorded twice). */
const recordedFailures = new WeakSet<object>();

async function recordFailureOnce(deps: JobDeps, name: string, data: unknown, err: unknown): Promise<void> {
  if (typeof err === "object" && err !== null) {
    if (recordedFailures.has(err)) return;
    recordedFailures.add(err);
  }
  await recordJobFailure(deps.db, name, data, err);
}

/**
 * Run one job. `name` is a QUEUE value; `data` is the job payload (ignored
 * by the periodic jobs, which read the database). Throws when the job fails,
 * so the runtime retries it (pg-boss retryLimit, Queues retry()).
 *
 * A failure is recorded as an ops event (job_failed) before it is rethrown;
 * a periodic job that completes records its heartbeat (tick.<name>).
 */
export async function runJob(name: string, data: unknown, deps: JobDeps): Promise<void> {
  try {
    await runJobInner(name, data, deps);
  } catch (err) {
    await recordFailureOnce(deps, name, data, err);
    throw err;
  }
  if (isPeriodicJob(name)) await recordTickRun(deps.db, name);
}

async function runJobInner(name: string, data: unknown, deps: JobDeps): Promise<void> {
  const { db } = deps;
  switch (name) {
    case QUEUE.SCAN:
      return runScan(db);

    case QUEUE.COMPILE: {
      const job = data as CompileJobData;
      try {
        await handleCompileJob(job, db);
      } catch (err) {
        console.error(`[compile] unhandled error for flow ${job.flow_id}:`, err);
        throw err;
      }
      return;
    }

    case QUEUE.TRIGGER_CHECK: {
      const job = data as TriggerCheckJobData;
      try {
        const result = await handleTriggerCheck(job, db);
        // Chain: enqueue targeted step advancement for each enrolled membership
        for (const membershipId of result.enrolledMembershipIds) {
          await deps.enqueue(
            QUEUE.ADVANCE_MEMBERSHIP,
            { tenant_id: job.tenant_id, membership_id: membershipId },
            { ...CHAIN_OPTS },
          );
        }
      } catch (err) {
        console.error(`[trigger-check] error for contact ${job.contact_id}, event "${job.event_name}":`, err);
        throw err;
      }
      return;
    }

    case QUEUE.DRAIN: {
      // Drain uses the real transport resolver (reads and decrypts transport_configs
      // per tick). On a fresh install with no transport configured, the resolver
      // returns null for every tenant and zero messages are sent or written.
      const resolveTransport = deps.resolveTransport ?? buildTenantTransportResolver(db);
      const now = new Date();

      // Read batch_size_per_tick from tenant throttle config, default to 50
      const tenantRow = await storeFor(db).workerIndex.getAnyTenantSettings();
      const batchLimit =
        tenantRow !== null
          ? resolveThrottleConfig(tenantRow.settings as Record<string, unknown> | null).batch_size_per_tick
          : 50;

      const result = await processDrainTick(db, now, resolveTransport, fetchDrainBatchSimple, batchLimit);
      // Alerts: configuration faults seen by this tick, and the send error
      // rate of the last 15 minutes (cron and targeted sends alike).
      await recordDrainFaults(db, result.configFaults ?? [], now);
      await checkSendErrors(db, now);
      if (result.candidatesFetched > 0) {
        console.log(
          `[drain] tick: ${result.candidatesFetched} candidates, ` +
            `${result.sent} sent, ${result.suppressed} suppressed, ` +
            `${result.deferredFrequency + result.deferredWindow} deferred, ` +
            `${result.skippedNoTransport} no-transport, ` +
            `${result.transportErrors} errors`,
        );
      }
      return;
    }

    case QUEUE.REAP: {
      // Finds messages stuck in 'sending', 'generating', or 'awaiting_content'
      // for > 2h and either retries them or marks them failed after MAX_RETRY_COUNT.
      const result = await processReapTick(db, new Date());
      const total =
        result.sendingRetried +
        result.sendingFailed +
        result.generatingRetried +
        result.generatingFailed +
        result.awaitingContentRetried +
        result.awaitingContentFailed;
      if (total > 0) {
        console.log(
          `[reap] tick: sending retried=${result.sendingRetried} failed=${result.sendingFailed}, ` +
            `generating retried=${result.generatingRetried} failed=${result.generatingFailed}, ` +
            `awaiting_content retried=${result.awaitingContentRetried} failed=${result.awaitingContentFailed}`,
        );
      }
      return;
    }

    case QUEUE.COUNTER_ROLLOVER: {
      // Only touches contacts whose bucket has aged past 15 days.
      const result = await processCounterRollover(db, new Date());
      if (result.contactsRolled > 0) {
        console.log(`[counter-rollover] tick: ${result.contactsRolled} contacts rolled`);
      }
      return;
    }

    case QUEUE.PARTITION_MAINTENANCE: {
      // Postgres only: ensures monthly partitions of events exist.
      const result = await processPartitionMaintenance(db, new Date());
      if (result.partitionsCreated.length > 0) {
        console.log(`[partition-maintenance] tick: created ${result.partitionsCreated.join(", ")}`);
      }
      return;
    }

    case QUEUE.CONTENT_GENERATION: {
      // Claims pending_generation messages, runs the Brain decide+draft+assess
      // pipeline (or renders a fixed template), and advances them. Then the
      // alert tick runs (late-tick check, resolution, alert mail), also when
      // the content work failed, so that failure is mailed in this tick.
      let failure: { err: unknown } | null = null;
      try {
        const now = new Date();
        const result = await processContentTick(db, now);
        for (const [tenantId, stats] of Object.entries(result.llmCalls ?? {})) {
          await recordLlmCalls(db, tenantId, stats, now);
        }
        if (result.claimed > 0) {
          console.log(
            `[content-generation] tick: ${result.claimed} claimed, ` +
              `${result.advanced} advanced, ${result.skipped} skipped, ` +
              `${result.valueGated} value_gated, ${result.errors} errors`,
          );
        }
      } catch (err) {
        failure = { err };
        await recordFailureOnce(deps, name, data, err);
      }
      await runAlertTick(db, { resolveTransport: deps.resolveTransport });
      // P5b: the daily waiting-approvals mail (settings.approvals.daily_digest).
      await runApprovalsDigest(db, new Date(), { resolveTransport: deps.resolveTransport }).catch((err) =>
        console.error("[approvals-digest] failed:", err),
      );
      if (failure) throw failure.err;
      return;
    }

    case QUEUE.WEBHOOK_DELIVERY: {
      // Outbound webhooks and the analytics sink (G5, G30).
      const result = await processWebhookTick(db, new Date(), { fetch: deps.fetch });
      if (result.claimed > 0) {
        console.log(
          `[webhook-delivery] tick: ${result.claimed} claimed, ${result.delivered} delivered, ` +
            `${result.retried} retried, ${result.dead} dead`,
        );
      }
      return;
    }

    case QUEUE.ALERTS_DIGEST: {
      // Daily digest mail and retention of ops data.
      const result = await runDigest(db, { resolveTransport: deps.resolveTransport });
      console.log(
        `[alerts-digest] ${result.sent ? "sent" : `not sent (${result.skipped ?? "send failed"})`}, ` +
          `${result.deletedEvents} old events deleted`,
      );
      return;
    }

    case QUEUE.KB_EMBED: {
      const job = data as KbEmbedJobData;
      try {
        await handleKbEmbedJob(job, db);
      } catch (err) {
        console.error(`[kb-embed] error for entry ${job.kb_entry_id}:`, err);
        throw err;
      }
      return;
    }

    case QUEUE.ADVANCE_MEMBERSHIP: {
      const job = data as AdvanceMembershipJobData;
      try {
        const result = await handleAdvanceMembership(job, db);
        if (result.messageCreated && result.messageId) {
          // Chain: enqueue targeted content generation for the new message
          await deps.enqueue(
            QUEUE.PROCESS_MESSAGE,
            { tenant_id: job.tenant_id, message_id: result.messageId },
            { singletonKey: result.messageId, ...CHAIN_OPTS },
          );
        }
        if (result.messageCreated || result.advanced || result.completed || result.exited) {
          console.log(
            `[advance-membership] membership ${job.membership_id}: ` +
              `message=${result.messageCreated} advanced=${result.advanced} ` +
              `completed=${result.completed} exited=${result.exited}`,
          );
        }
      } catch (err) {
        console.error(`[advance-membership] error for membership ${job.membership_id}:`, err);
        throw err;
      }
      return;
    }

    case QUEUE.PROCESS_MESSAGE: {
      const job = data as ProcessMessageJobData;
      try {
        const result = await handleProcessMessage(job, db);
        if (result.llm) await recordLlmCalls(db, job.tenant_id, result.llm);
        if (result.claimed) {
          console.log(`[process-message] message ${job.message_id}: ${result.outcome}`);
          // Chain: if message reached 'approved' (auto-approve), enqueue targeted drain
          if (result.outcome === "advanced") {
            await deps.enqueue(
              QUEUE.DRAIN_MESSAGE,
              { tenant_id: job.tenant_id, message_id: job.message_id },
              { singletonKey: job.message_id, ...CHAIN_OPTS },
            );
          }
        }
      } catch (err) {
        console.error(`[process-message] error for message ${job.message_id}:`, err);
        throw err;
      }
      return;
    }

    case QUEUE.GRID_SNAPSHOT: {
      // Records the day's retention-grid cell populations for every tenant.
      const result = await processGridSnapshotTick(db, new Date());
      console.log(
        `[grid-snapshot] tick: ${result.tenantsProcessed} tenants, ` +
          `${result.rowsWritten} rows for ${result.snapshotDate}`,
      );
      return;
    }

    case QUEUE.DRAIN_MESSAGE: {
      const job = data as DrainMessageJobData;
      const resolveTransport = deps.resolveTransport ?? buildTenantTransportResolver(db);
      try {
        const result = await handleDrainMessage(job, db, resolveTransport);
        if (result.claimed) {
          console.log(`[drain-message] message ${job.message_id}: ${result.outcome}`);
        }
      } catch (err) {
        console.error(`[drain-message] error for message ${job.message_id}:`, err);
        throw err;
      }
      return;
    }

    default:
      throw new Error(`[worker] unknown job: ${name}`);
  }
}

/**
 * Scan: phases run sequentially. Phase 1 time transitions, phase 2
 * enrollment from those transitions, phase 2b segment enrollment, phase 3
 * step advancement, phase 4 engagement depth.
 */
async function runScan(db: Db): Promise<void> {
  const now = new Date();

  // P5b: archived products are not scanned (no transitions, enrollments or
  // new messages) until they are unarchived.
  const tenantIds = await storeFor(db).workerIndex.listActiveTenantIds();
  if (tenantIds.length === 0) return;

  // Phase 1: time-based lifecycle transitions
  const phase1 = await phaseTimeTransitions(db, now, tenantIds);
  console.log(
    `[scan] time-transitions: ${phase1.tenantsProcessed} tenants, ` +
      `${phase1.contactsEvaluated} contacts evaluated, ` +
      `${phase1.transitionsApplied} transitions applied`,
  );

  // Phase 2: enroll contacts into lifecycle-transition-triggered flows
  // Uses transitions from phase 1 as input (only newly-transitioned contacts).
  if (phase1.appliedTransitions.length > 0) {
    const phase2 = await phaseEnrollment(db, phase1.appliedTransitions, now);
    console.log(
      `[scan] enrollment: ${phase2.transitionsEvaluated} transitions evaluated, ` +
        `${phase2.enrollmentsSucceeded}/${phase2.enrollmentsAttempted} enrollments, ` +
        `${phase2.evictions} evictions`,
    );
  }

  // Phase 2b: enroll contacts into segment-triggered flows (retention
  // grid cells). Bounded per flow per run by SEGMENT_ENROLLMENT_CAP.
  const phase2b = await phaseSegmentEnrollment(db, now, tenantIds);
  if (phase2b.flowsEvaluated > 0) {
    console.log(
      `[scan] segment-enrollment: ${phase2b.flowsEvaluated} segment flows, ` +
        `${phase2b.enrollmentsSucceeded}/${phase2b.enrollmentsAttempted} enrollments` +
        (phase2b.flowsCapped > 0 ? `, ${phase2b.flowsCapped} capped` : ""),
    );
  }

  // Phase 2c: date-property triggers and schedules (G3), and step expiry.
  const phase2c = await phaseDateEnrollment(db, now, tenantIds);
  if (phase2c.flowsEvaluated > 0 || phase2c.expiredCancelled > 0) {
    console.log(
      `[scan] date-enrollment: ${phase2c.flowsEvaluated} date flows, ` +
        `${phase2c.enrollmentsSucceeded}/${phase2c.enrollmentsAttempted} enrollments, ` +
        `${phase2c.staleExited} stale exits, ${phase2c.expiredCancelled} expired messages cancelled`,
    );
  }

  // Phase 3: step advancement and message creation
  const phase3 = await phaseStepAdvancement(db, now, tenantIds);
  console.log(
    `[scan] step-advancement: ${phase3.tenantsProcessed} tenants, ` +
      `${phase3.membershipsEvaluated} memberships evaluated, ` +
      `${phase3.messagesCreated} messages created, ` +
      `${phase3.stepsAdvanced} steps advanced, ` +
      `${phase3.membershipsCompleted} completed, ` +
      `${phase3.membershipsExitedArchived} exited (archived)`,
  );

  // Phase 4: engagement_depth computation for engaged contacts.
  // Runs unconditionally every tick (one aggregate query per tenant).
  const phase4 = await phaseEngagementDepth(db, now, tenantIds);
  if (phase4.contactsUpdated > 0) {
    console.log(
      `[scan] engagement-depth: ${phase4.tenantsProcessed} tenants, ` +
        `${phase4.contactsUpdated} contacts updated, ` +
        `${phase4.contactsUnchanged} unchanged`,
    );
  }
}
