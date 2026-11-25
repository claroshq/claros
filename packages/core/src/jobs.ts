/**
 * Job queue contract: queue names and job payload types.
 *
 * Only queues whose handler is implemented belong here. Add a name and its
 * payload type in the same commit as the handler in packages/worker.
 *
 * No pg-boss import; payload types are plain TypeScript.
 * The scheduler (packages/scheduler) and API layer (packages/api) import
 * queue names from here without importing worker logic.
 */

// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------

export const QUEUE = {
  /**
   * Scan contacts for flow eligibility (every 15 min).
   * Payload: empty - handler reads from DB directly.
   * Handler: packages/worker (task 12).
   * Schedule: packages/scheduler, cron "every-15 * * * *".
   */
  SCAN: "claros.scan",

  /**
   * Compile a flow's natural-language prompt into a deterministic execution plan.
   * Payload: flow_id + tenant_id.
   * Handler: packages/worker (task 11).
   * Trigger: POST /v1/flows/:id/compile enqueues on demand.
   * Singleton: singletonKey = flow_id (one compile per flow at a time).
   */
  COMPILE: "claros.compile",

  /**
   * Evaluate event-triggered flows for a single contact after an event is ingested.
   * Payload: tenant_id, contact_id, event_name.
   * Handler: packages/worker (task 12b).
   * Trigger: ingest route enqueues after inserting an event.
   * Latency: seconds (not waiting for the 15-min scan interval).
   */
  TRIGGER_CHECK: "claros.trigger-check",

  /**
   * Drain: pick up approved messages and hand them to transport (every 15 min).
   * Payload: empty - handler queries the database for approved messages.
   * Handler: packages/worker (task 14).
   * Schedule: packages/scheduler, cron at drain_interval_minutes.
   *
   * Dependency: the reap worker (task 15) recovers messages stuck at 'sending'
   * after transport errors.
   */
  DRAIN: "claros.drain",

  /**
   * Reap: recover messages stuck in 'sending', 'generating', or 'awaiting_content' (every hour).
   * Payload: empty - handler queries the database for stuck messages.
   * Handler: packages/worker (task 15).
   * Schedule: packages/scheduler, cron "0 * * * *" (top of every hour).
   *
   * A message is stuck when its updated_at is older than REAP_STUCK_THRESHOLD_HOURS (2h)
   * and its status has not advanced. Recovery:
   *   - 'sending' stuck > 2h: reset to 'approved', increment retry_count.
   *   - 'generating' stuck > 2h: reset to 'pending_generation', increment retry_count.
   *   - 'awaiting_content' stuck > 2h: reset to 'pending_generation', increment retry_count.
   *     (Covers failures in draft(), value gate, budget check, or process crash after decide().)
   *   - retry_count >= MAX_RETRY_COUNT (3): set to 'failed' (terminal).
   */
  REAP: "claros.reap",

  /**
   * Counter rollover: rotate engagement depth buckets (every scan tick, 15 min).
   * The handler rolls over contacts whose last_counter_reset_at is older than
   * 15 days: bucket_prev = bucket_current, bucket_current = 0, reset timestamp.
   * Payload: empty - handler queries contacts by last_counter_reset_at.
   * Handler: packages/worker (task 14.5).
   * Schedule: packages/scheduler, cron every 15 min (piggybacks on scan interval).
   */
  COUNTER_ROLLOVER: "claros.counter-rollover",

  /**
   * Partition maintenance: ensure future monthly partitions exist for the events table.
   * Checks whether next month's partition exists; creates it if missing.
   * Payload: empty.
   * Handler: packages/worker (task 14.5).
   * Schedule: packages/scheduler, cron every 15 min (frequent + idempotent).
   */
  PARTITION_MAINTENANCE: "claros.partition-maintenance",

  /**
   * Content generation: claim pending_generation messages, run Brain decide+draft.
   * Payload: empty - handler queries the database for pending_generation messages.
   * Handler: packages/worker (task 17).
   * Schedule: packages/scheduler, cron every 5 min.
   *
   * Uses FOR UPDATE SKIP LOCKED + CAS to claim messages atomically, same pattern
   * as drain. Reap (task 15) recovers messages stuck at 'generating' after timeout.
   */
  CONTENT_GENERATION: "claros.content-generation",

  /**
   * KB embedding: generate a pgvector embedding for a single kb_entries row.
   * Payload: kb_entry_id + tenant_id.
   * Handler: packages/worker (task 22).
   * Trigger: POST /v1/kb (on create) and PATCH /v1/kb/:id (when content changes).
   *
   * singletonKey = kb_entry_id: only one embedding job runs per entry at a time.
   * A content update while an embedding is in flight cancels the stale job
   * implicitly - the new job lands and uses the latest content row.
   *
   * Failure path: provider errors are retried via pg-boss retryLimit/retryDelay.
   * A permanently failing entry remains identifiable: its embedding column stays
   * NULL, and the pg-boss job table records the failure.
   *
   * Re-embedding is triggered only when content changes. Tag-only or other
   * field-only updates must not enqueue this job.
   */
  KB_EMBED: "claros.kb-embed",

  /**
   * Targeted step advancement: process a single membership's current step.
   * Payload: tenant_id, membership_id.
   * Handler: packages/worker (advance-membership.ts).
   * Trigger: enqueued after successful enrollment (trigger-check, scan-enrollment).
   *
   * Eliminates the 15-min scan wait for newly enrolled contacts. The periodic
   * scan remains as a safety net for memberships that miss the targeted path
   * (e.g. enqueue failure, process crash).
   *
   * No singletonKey: multiple enrollments for different memberships are independent.
   * If the same membership is enqueued twice, the second job finds the step already
   * advanced and short-circuits (CAS on current_step prevents double-advance).
   */
  ADVANCE_MEMBERSHIP: "claros.advance-membership",

  /**
   * Targeted content generation: process a single pending_generation message.
   * Payload: tenant_id, message_id.
   * Handler: packages/worker (process-message.ts).
   * Trigger: enqueued after step advancement creates a pending_generation message.
   *
   * Eliminates the 5-min content-generation wait. The periodic content tick
   * remains as a safety net for messages that miss the targeted path.
   *
   * singletonKey = message_id: only one content job per message at a time.
   * If the message is already claimed by the cron tick, the targeted job finds
   * status != 'pending_generation' and returns immediately.
   */
  PROCESS_MESSAGE: "claros.process-message",

  /**
   * Targeted drain: send a single approved message.
   * Payload: tenant_id, message_id.
   * Handler: packages/worker (drain-message.ts).
   * Trigger: enqueued after a message reaches 'approved' (auto-approve in content
   * generation, manual approval via POST /v1/messages/:id/approve).
   *
   * Eliminates the 15-min drain wait. The periodic drain tick remains as a
   * safety net for messages that miss the targeted path.
   *
   * singletonKey = message_id: only one drain job per message at a time.
   * If the message is already claimed by the cron drain, the targeted job finds
   * status != 'approved' and returns immediately.
   */
  DRAIN_MESSAGE: "claros.drain-message",

  /**
   * Grid snapshot: record the day's retention-grid cell populations.
   * Payload: empty - handler queries contacts per tenant and upserts 16 rows
   * (one per cell) into retention_grid_snapshots for the current UTC day.
   * Handler: packages/worker (snapshot-retention-grid.ts).
   * Schedule: packages/scheduler, cron daily.
   *
   * Idempotent: re-running on the same day overwrites that day's rows.
   */
  GRID_SNAPSHOT: "claros.grid-snapshot",

  /**
   * Alerts digest: the daily operational digest mail (open alerts, the last
   * 24 hours of ops events, sends and failures per product, pending
   * approvals) and the retention of ops_events (30 days).
   * Payload: empty.
   * Handler: packages/worker (alerts.ts).
   * Schedule: daily at 07:00 UTC (pg-boss "0 7 * * *", Workers: the 07:00 tick).
   */
  ALERTS_DIGEST: "claros.alerts-digest",

  /**
   * Webhook delivery: send due outbound webhook and analytics outbox rows
   * (G5, G30) with retries and backoff.
   * Payload: empty.
   * Handler: packages/worker (webhooks.ts).
   * Schedule: every minute (pg-boss "* * * * *"); Workers: every 5-minute tick.
   */
  WEBHOOK_DELIVERY: "claros.webhook-delivery",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// ---------------------------------------------------------------------------
// Job payload types
// ---------------------------------------------------------------------------

/**
 * SCAN job: no payload. The worker queries the database for eligible contacts.
 * Cron-triggered; the scheduler sends an empty object every 15 minutes.
 */
export type ScanJobData = Record<string, never>;

/**
 * COMPILE job: identifies which flow to compile and the owning tenant.
 * Enqueued by the API on POST /v1/flows/:id/compile.
 */
export interface CompileJobData {
  flow_id: string;
  tenant_id: string;
}

/**
 * TRIGGER_CHECK job: evaluate event-triggered flows for one contact.
 * Enqueued by the ingest route after inserting a track event.
 */
export interface TriggerCheckJobData {
  tenant_id: string;
  contact_id: string;
  event_name: string;
}

/**
 * DRAIN job: no payload. The worker queries the database for approved messages.
 * Cron-triggered; the scheduler sends an empty object at drain_interval_minutes.
 *
 * NOTE: After task 14, the drain sends nothing in any real deployment. The
 * transport resolver returns null until Phase 4 builds real adapters (tasks 26-28).
 * Messages that pass the throttle gate remain at 'approved' and are re-evaluated
 * each tick. "Drain implemented" means scheduling, batch selection, throttle
 * evaluation, and transport seam are wired - not "email works."
 */
export type DrainJobData = Record<string, never>;

/**
 * REAP job: no payload. The worker queries the database for stuck messages.
 * Cron-triggered; the scheduler sends an empty object every REAP_INTERVAL_MINUTES (60).
 */
export type ReapJobData = Record<string, never>;

/**
 * COUNTER_ROLLOVER job: no payload. The worker rotates engagement counter
 * buckets for contacts whose current bucket has aged past 15 days.
 */
export type CounterRolloverJobData = Record<string, never>;

/**
 * PARTITION_MAINTENANCE job: no payload. The worker checks that next month's
 * partition exists on the events table and creates it if missing.
 */
export type PartitionMaintenanceJobData = Record<string, never>;

/**
 * CONTENT_GENERATION job: no payload. The worker queries the database for
 * messages at 'pending_generation' status and runs Brain decide+draft on each.
 * Cron-triggered; the scheduler sends an empty object every 5 minutes.
 */
export type ContentGenerationJobData = Record<string, never>;

/**
 * KB_EMBED job: identifies which kb_entries row to embed and the owning tenant.
 * Enqueued by POST /v1/kb (on create) and PATCH /v1/kb/:id (when content changes).
 * singletonKey = kb_entry_id so concurrent updates produce one embedding job.
 */
export interface KbEmbedJobData {
  kb_entry_id: string;
  tenant_id: string;
}

/**
 * ADVANCE_MEMBERSHIP job: process a single membership's current step.
 * Enqueued after enrollment (trigger-check or scan-enrollment).
 */
export interface AdvanceMembershipJobData {
  tenant_id: string;
  membership_id: string;
}

/**
 * PROCESS_MESSAGE job: run content generation for a single message.
 * Enqueued after step advancement creates a pending_generation message.
 * singletonKey = message_id.
 */
export interface ProcessMessageJobData {
  tenant_id: string;
  message_id: string;
}

/**
 * DRAIN_MESSAGE job: send a single approved message.
 * Enqueued after a message reaches 'approved' status.
 * singletonKey = message_id.
 */
export interface DrainMessageJobData {
  tenant_id: string;
  message_id: string;
}

/**
 * GRID_SNAPSHOT job: no payload. The worker snapshots every tenant's
 * retention-grid cell populations for the current UTC day.
 */
export type GridSnapshotJobData = Record<string, never>;

/**
 * ALERTS_DIGEST job: no payload. The worker reads ops_events, ops_alerts and
 * message counts and mails the digest when there is something to report.
 */
export type AlertsDigestJobData = Record<string, never>;

/** WEBHOOK_DELIVERY job: no payload. The worker claims due outbox rows. */
export type WebhookDeliveryJobData = Record<string, never>;
