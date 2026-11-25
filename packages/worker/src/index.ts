/**
 * @claros/worker - Background job processing.
 *
 * Exports:
 *   - createBoss(connectionString, opts?): creates a configured PgBoss instance.
 *     Called by apps/server before startWorker / startScheduler.
 *   - startWorker(boss, db): registers work() handlers that call runJob().
 *     Add a queue to POLLING (and a case to runJob) in the same commit as the
 *     queue name in @claros/core.
 *   - fromDrizzle: pg-boss Drizzle transaction adapter, re-exported so API
 *     routes can enqueue jobs atomically inside Drizzle transactions without
 *     a direct pg-boss import.
 *
 * The job logic lives in ./handlers.ts (runJob), shared with the Cloudflare
 * Workers runtime; this file is only the pg-boss wiring. Importing
 * `@claros/worker/handlers` does not load pg-boss.
 *
 * Queue names and payload types live in @claros/core. Import them from there.
 * Nothing re-exports the queue contract through this package.
 *
 * Connection model:
 *   pg-boss opens its own pg.Pool (max=3, sized up in Phase 2 once real
 *   concurrency is known). The Drizzle pool used by the API is separate.
 *   See apps/server/src/main.ts for per-role connection totals.
 */
import { PgBoss, fromDrizzle } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { QUEUE } from "@claros/core";
import { runJob, type JobDeps } from "./handlers.js";
import { buildTenantTransportResolver } from "./transport-resolver.js";
import { recordDeadLetter } from "./alerts.js";

export { fromDrizzle };
export * from "./handlers.js";
export const CLAROS_WORKER_VERSION = "0.0.0";

type Db = NodePgDatabase<Record<string, never>>;

// ---------------------------------------------------------------------------
// Boss factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a configured PgBoss instance. Does NOT call start().
 * The caller (apps/server) calls boss.start() then passes the instance to
 * startWorker() and/or startScheduler().
 *
 * @param connectionString - DATABASE_URL for the pg-boss pool.
 * @param opts - Optional overrides (e.g. { schedule: false } for worker-only role).
 */
export function createBoss(
  connectionString: string,
  opts: Partial<ConstructorParameters<typeof PgBoss>[0]> = {},
): PgBoss {
  return new PgBoss({
    connectionString,
    // The default "pgboss" schema is used. drizzle-kit never sees it because
    // drizzle.config.ts scans only ./drizzle/schema/*.ts, not the live DB.
    schema: "pgboss",
    // Conservative pool for now - no real work runs yet.
    // Raise in Phase 2 when drain/scan concurrency is known.
    max: 3,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/**
 * Registers all work() handlers on the supplied PgBoss instance.
 * Must be called after boss.start() resolves.
 *
 * Each queue is explicitly created before the work() handler is registered.
 * boss.work() alone creates the queue row lazily (on the first internal poll),
 * which means boss.schedule() in startScheduler() can fail with a FK violation
 * if it runs before that first poll. createQueue() is idempotent (upsert) and
 * ensures the row exists immediately so schedule() can reference it.
 *
 * Pattern: one POLLING entry per queue constant and one runJob() case. Add both
 * in the same commit as the queue name in @claros/core and the handler logic.
 */
export async function startWorker(boss: PgBoss, db: Db): Promise<void> {
  // Ensure queue rows exist before any boss.schedule() call can reference them.
  for (const queue of Object.values(QUEUE)) {
    await boss.createQueue(queue);
  }

  const enqueue: JobDeps["enqueue"] = (queue, data, opts) => boss.send(queue, data, opts ?? {});
  // Drain builds a fresh resolver per tick (runJob default); drain-message
  // shares one resolver for the life of the worker, as before the split.
  const drainMessageDeps: JobDeps = { db, enqueue, resolveTransport: buildTenantTransportResolver(db) };
  const deps: JobDeps = { db, enqueue };

  for (const [queue, pollingIntervalSeconds] of POLLING) {
    const jobDeps = queue === QUEUE.DRAIN_MESSAGE ? drainMessageDeps : deps;
    await boss.work(
      queue,
      { pollingIntervalSeconds, includeMetadata: true as const },
      async (jobs: JobWithMetadata<Record<string, unknown>>[]) => {
        if (PERIODIC.has(queue)) {
          // Cron-triggered singleton: one run per batch, the payload is empty.
          await runWithDeadLetter(db, queue, jobs[0], jobs[0]?.data ?? {}, jobDeps);
          return;
        }
        for (const job of jobs) {
          // Throws on failure: pg-boss marks the job failed and retries per retryLimit.
          await runWithDeadLetter(db, queue, job, job.data, jobDeps);
        }
      },
    );
  }
}

/**
 * Run a job; when it fails on its last attempt (retries exhausted), record a
 * dead letter ops event before pg-boss marks it failed for good.
 */
async function runWithDeadLetter(
  db: Db,
  queue: string,
  job: JobWithMetadata<Record<string, unknown>> | undefined,
  data: Record<string, unknown>,
  deps: JobDeps,
): Promise<void> {
  try {
    await runJob(queue, data, deps);
  } catch (err) {
    if (job && typeof job.retryLimit === "number" && job.retryCount >= job.retryLimit) {
      await recordDeadLetter(db, queue, data, job.retryCount + 1, err);
    }
    throw err;
  }
}

/** Queues whose jobs are periodic ticks with an empty payload. */
const PERIODIC = new Set<string>([
  QUEUE.SCAN,
  QUEUE.DRAIN,
  QUEUE.REAP,
  QUEUE.COUNTER_ROLLOVER,
  QUEUE.PARTITION_MAINTENANCE,
  QUEUE.CONTENT_GENERATION,
  QUEUE.GRID_SNAPSHOT,
  QUEUE.ALERTS_DIGEST,
]);

/** work() registration order and polling interval (seconds) per queue. */
const POLLING: ReadonlyArray<readonly [string, number]> = [
  [QUEUE.SCAN, 5],
  [QUEUE.COMPILE, 2],
  [QUEUE.TRIGGER_CHECK, 2],
  [QUEUE.DRAIN, 5],
  [QUEUE.REAP, 5],
  [QUEUE.COUNTER_ROLLOVER, 5],
  [QUEUE.PARTITION_MAINTENANCE, 5],
  [QUEUE.CONTENT_GENERATION, 5],
  [QUEUE.KB_EMBED, 5],
  [QUEUE.ADVANCE_MEMBERSHIP, 2],
  [QUEUE.PROCESS_MESSAGE, 2],
  [QUEUE.GRID_SNAPSHOT, 30],
  [QUEUE.DRAIN_MESSAGE, 2],
  [QUEUE.ALERTS_DIGEST, 30],
];
