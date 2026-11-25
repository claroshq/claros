/**
 * Periodic jobs for runtimes with a single cron trigger (Cloudflare Workers).
 *
 * On Node, pg-boss runs one cron schedule per queue (packages/scheduler). A
 * Worker has one Cron Trigger, every 5 minutes; dueTicks() says which
 * periodic jobs are due at a tick so the same schedules are reproduced:
 *
 *   content-generation   every 5 minutes        (pg-boss "*\/5 * * * *")
 *   scan                 every 15 minutes       ("*\/15 * * * *")
 *   drain                every 15 minutes       ("*\/15 * * * *")
 *   counter-rollover     every 15 minutes       ("*\/15 * * * *")
 *   reap                 hourly at :00          ("0 * * * *")
 *   grid-snapshot        daily on the 00:15 UTC tick (pg-boss: 00:17 UTC)
 *   alerts-digest        daily on the 07:00 UTC tick
 *
 * Partition maintenance is not returned: it manages Postgres partitions of
 * `events`, which D1 does not have.
 *
 * Times are UTC. A tick is the 5-minute slot that contains `now`, so a
 * trigger that fires a few seconds late still counts as its slot.
 */
import { QUEUE, type QueueName } from "./jobs.js";

export function dueTicks(now: Date): QueueName[] {
  const minute = now.getUTCMinutes() - (now.getUTCMinutes() % 5);
  const hour = now.getUTCHours();

  const due: QueueName[] = [QUEUE.CONTENT_GENERATION];
  if (minute % 15 === 0) {
    due.push(QUEUE.SCAN, QUEUE.DRAIN, QUEUE.COUNTER_ROLLOVER);
  }
  if (minute === 0) {
    due.push(QUEUE.REAP);
  }
  if (hour === 0 && minute === 15) {
    due.push(QUEUE.GRID_SNAPSHOT);
  }
  if (hour === 7 && minute === 0) {
    due.push(QUEUE.ALERTS_DIGEST);
  }
  return due;
}

/**
 * Interval of every periodic job, in minutes. Each periodic run records its
 * last successful run (instance setting `tick.<name>`); the alert check
 * raises "tick late" when a run is older than TICK_LATE_FACTOR intervals.
 */
export const TICK_INTERVAL_MINUTES: Readonly<Record<string, number>> = {
  [QUEUE.CONTENT_GENERATION]: 5,
  [QUEUE.SCAN]: 15,
  [QUEUE.DRAIN]: 15,
  [QUEUE.COUNTER_ROLLOVER]: 15,
  [QUEUE.PARTITION_MAINTENANCE]: 15,
  [QUEUE.REAP]: 60,
  [QUEUE.GRID_SNAPSHOT]: 24 * 60,
  [QUEUE.ALERTS_DIGEST]: 24 * 60,
};

/** A tick is late when its last run is older than this many intervals. */
export const TICK_LATE_FACTOR = 3;

/** True for the periodic jobs (the ones with a TICK_INTERVAL_MINUTES entry). */
export function isPeriodicJob(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TICK_INTERVAL_MINUTES, name);
}

/** "claros.content-generation" -> "content-generation" (the tick.<name> setting suffix). */
export function tickName(queue: string): string {
  return queue.startsWith("claros.") ? queue.slice("claros.".length) : queue;
}
