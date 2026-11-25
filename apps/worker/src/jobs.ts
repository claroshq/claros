/**
 * Jobs on Cloudflare Queues: the enqueue function for the API and the job
 * chain, and the consumers of JOBS and its dead letter queue.
 */
import type { EnqueueFn } from "@claros/api";
import { recordDeadLetter, runJob, type JobDeps } from "@claros/worker/handlers";
import type { JobMessage, MessageBatch, Queue } from "./bindings.js";

/**
 * enqueue(queue, data, opts) on Cloudflare Queues. Every job goes to JOBS as
 * { name, data }. Of the pg-boss options, retryDelay becomes the base of the
 * retry backoff and startAfter (seconds) a delivery delay; singletonKey and
 * expireIn* have no Queues equivalent (handlers are idempotent: messages move
 * through compare-and-swap state transitions), and the retry count is the
 * consumer's max_retries.
 */
export function queueEnqueue(queue: Queue<JobMessage>): EnqueueFn {
  return async (name, data, opts) => {
    const retryDelay = typeof opts?.retryDelay === "number" ? opts.retryDelay : undefined;
    const startAfter = typeof opts?.startAfter === "number" ? opts.startAfter : undefined;
    await queue.send(
      { name, data, ...(retryDelay !== undefined ? { retryDelay } : {}) },
      startAfter !== undefined ? { delaySeconds: Math.max(0, Math.min(startAfter, MAX_DELAY_SECONDS)) } : undefined,
    );
    return null;
  };
}

/** Queues accepts delays up to 12 hours. */
const MAX_DELAY_SECONDS = 43_200;
/** Longest retry backoff. */
const MAX_BACKOFF_SECONDS = 900;
const DEFAULT_RETRY_DELAY_SECONDS = 10;

/** Exponential backoff: base, 2x base, 4x base, ... capped at 15 minutes. */
export function retryDelaySeconds(attempts: number, base = DEFAULT_RETRY_DELAY_SECONDS): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(1, base) * 2 ** exponent);
}

/** Run each message as one job: ack on success, retry with backoff on failure. */
export async function consumeJobs(batch: MessageBatch<JobMessage>, deps: JobDeps): Promise<void> {
  for (const message of batch.messages) {
    const { name, data, retryDelay } = message.body;
    try {
      await runJob(name, data ?? {}, deps);
      message.ack();
    } catch (err) {
      const delaySeconds = retryDelaySeconds(message.attempts, retryDelay);
      console.error(
        `[queue] job ${name} failed (attempt ${message.attempts}), retrying in ${delaySeconds}s:`,
        err instanceof Error ? err.message : err,
      );
      message.retry({ delaySeconds });
    }
  }
}

/**
 * Dead letter queue: jobs that failed on every retry. Logged with their
 * payload, recorded as a dead_letter ops event (an alert mail within one
 * content tick) and acknowledged. Recording never throws.
 */
export async function consumeDeadJobs(batch: MessageBatch<JobMessage>, db: JobDeps["db"]): Promise<void> {
  for (const message of batch.messages) {
    const name = message.body?.name ?? "unknown";
    console.error(`[queue] dead job ${name} after ${message.attempts} attempts:`, JSON.stringify(message.body?.data ?? null));
    await recordDeadLetter(db, name, message.body?.data ?? null, message.attempts);
    message.ack();
  }
}
