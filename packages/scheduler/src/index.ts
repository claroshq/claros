/**
 * @claros/scheduler - Registers cron schedules on the pg-boss instance.
 *
 * The scheduler role's only job is to call boss.schedule() for each recurring
 * job. It does NOT call boss.work(). Workers (startWorker) own the handler
 * side; the scheduler owns the trigger side.
 *
 * Depends on @claros/core (queue names) and pg-boss (PgBoss type).
 * Does NOT depend on @claros/worker. The queue name string is the only
 * interface between scheduler and worker at the code level.
 *
 * Pattern: one boss.schedule() call per cron-triggered queue constant.
 * Add a new schedule here in the same commit as the queue name in @claros/core
 * and the handler in @claros/worker.
 */
import type { PgBoss } from "pg-boss";
import { QUEUE } from "@claros/core";

export const CLAROS_SCHEDULER_VERSION = "0.0.0";

/**
 * Registers (or updates) cron schedules on the supplied PgBoss instance.
 * Must be called after boss.start() resolves.
 *
 * Schedules are upserted - safe to call on every startup.
 * pg-boss deduplicates cron firings across concurrent instances using
 * internal job throttling, so multiple scheduler processes are safe.
 */
export async function startScheduler(boss: PgBoss): Promise<void> {
  // scan: every 15 minutes (5-placeholder cron, minute-level precision)
  await boss.schedule(QUEUE.SCAN, "*/15 * * * *", {});

  // drain: every 15 minutes (matches DRAIN_INTERVAL_MINUTES default from Appendix B).
  // Picks up approved messages, evaluates throttle gate, hands to transport.
  await boss.schedule(QUEUE.DRAIN, "*/15 * * * *", {});

  // reap: every 60 minutes (matches REAP_INTERVAL_MINUTES from Appendix B).
  // Recovers messages stuck in 'sending', 'generating', or 'awaiting_content' for > 2h.
  // Interval differs from drain: a message must be stuck for 2h before reap
  // acts; running reap more frequently would be redundant for most of that window.
  await boss.schedule(QUEUE.REAP, "0 * * * *", {});

  // counter-rollover: every 15 minutes. Rotates engagement event count buckets
  // for contacts whose last_counter_reset_at is older than 15 days.
  // Cheap no-op when no contacts are due for rollover.
  await boss.schedule(QUEUE.COUNTER_ROLLOVER, "*/15 * * * *", {});

  // partition-maintenance: every 15 minutes. Ensures monthly range partitions
  // on the events table exist for current month + 2 months ahead.
  // Idempotent and cheap (pg_class lookup) when partitions already exist.
  await boss.schedule(QUEUE.PARTITION_MAINTENANCE, "*/15 * * * *", {});

  // content-generation: every 5 minutes. Claims pending_generation messages
  // and runs Brain decide+draft. More frequent than drain because LLM calls
  // have latency; smaller batches processed more often keeps pipeline moving.
  await boss.schedule(QUEUE.CONTENT_GENERATION, "*/5 * * * *", {});

  // grid-snapshot: daily at 00:17 UTC (off the top of the hour). Records the
  // day's retention-grid cell populations for the cell trend view.
  // Idempotent: a re-run on the same day overwrites that day's rows.
  await boss.schedule(QUEUE.GRID_SNAPSHOT, "17 0 * * *", {});
}
