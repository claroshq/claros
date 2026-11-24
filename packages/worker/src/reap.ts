/**
 * Reap worker - recovers messages stuck in 'sending', 'generating', or
 * 'awaiting_content'.
 *
 * Scheduled every REAP_INTERVAL_MINUTES (60 min) via pg-boss cron ("0 * * * *").
 *
 * A message is considered stuck when its updated_at is older than
 * REAP_STUCK_THRESHOLD_HOURS (2h) and its status has not advanced.
 * updated_at is the correct column because drain.ts sets it on every
 * status write, so it accurately records when the message last moved.
 *
 * Recovery per status:
 *   - 'sending' stuck > 2h: reset to 'approved', increment retry_count.
 *     Drain will pick it up again on the next tick.
 *   - 'generating' stuck > 2h: reset to 'pending_generation', increment retry_count.
 *     The Brain worker will re-attempt the decision.
 *   - 'awaiting_content' stuck > 2h: reset to 'pending_generation', increment retry_count.
 *     'awaiting_content' is entered after decide() succeeds and is left only
 *     when the full draft+assess sequence completes. Failures in draft(), the
 *     value gate, the budget check, or a process crash leave the row at
 *     'awaiting_content' with no terminal state and no other recovery path.
 *     Resetting to 'pending_generation' re-enters the full pipeline: the fresh
 *     run will re-decide and re-draft. The same retry ceiling applies so a
 *     permanently failing message still terminates rather than looping.
 *   - retry_count >= MAX_RETRY_COUNT (3): set to 'failed' (terminal). Logged
 *     for observability; no alerting system exists yet.
 *
 * Concurrency with drain:
 *   All writes use CAS (updated_at < threshold AND status = expected). If drain
 *   concurrently advances a 'sending' row to 'sent' while reap is evaluating it,
 *   reap's update hits 0 rows and the drain outcome wins (correct: message sent).
 *   Drain's own writes (task 14 fix) include AND status = 'sending', so if reap
 *   resets a row to 'approved' first, drain's success write hits 0 rows and the
 *   contact gets a retry.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// ---------------------------------------------------------------------------
// Constants (from spec Appendix B)
// ---------------------------------------------------------------------------

/** Messages stuck for longer than this are eligible for reap. */
const REAP_STUCK_THRESHOLD_HOURS = 2;

/** After this many retries, the message is marked failed (terminal). */
const MAX_RETRY_COUNT = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Stats returned by processReapTick for observability. */
export interface ReapTickResult {
  sendingRetried: number;
  sendingFailed: number;
  generatingRetried: number;
  generatingFailed: number;
  awaitingContentRetried: number;
  awaitingContentFailed: number;
}

// ---------------------------------------------------------------------------
// Reap tick processor
// ---------------------------------------------------------------------------

/**
 * Process a single reap tick. Called by the pg-boss handler.
 *
 * Finds all messages whose updated_at is older than REAP_STUCK_THRESHOLD_HOURS
 * and whose status is 'sending', 'generating', or 'awaiting_content', then
 * recovers or terminates them.
 *
 * Each UPDATE is atomic CAS:
 *   WHERE status = <expected> AND updated_at < <threshold>
 * If drain (or anything else) has already advanced the row, the update hits
 * 0 rows and the other actor's outcome wins.
 *
 * @param db  - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope. When provided, only messages for
 *   these tenants are processed. When omitted, all tenants are processed
 *   (production default).
 */
export async function processReapTick(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<ReapTickResult> {
  const stats: ReapTickResult = {
    sendingRetried: 0,
    sendingFailed: 0,
    generatingRetried: 0,
    generatingFailed: 0,
    awaitingContentRetried: 0,
    awaitingContentFailed: 0,
  };

  const threshold = new Date(now.getTime() - REAP_STUCK_THRESHOLD_HOURS * 60 * 60 * 1000);

  // Optional tenant scope fragment. When tenantIds is provided, only those
  // tenants' messages are processed. When omitted (production default), the
  // fragment is a no-op (TRUE).
  const tenantFilter = tenantIds && tenantIds.length > 0
    ? sql`AND tenant_id IN (${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  // ---------------------------------------------------------------------------
  // Recover 'sending' messages (stuck drain)
  //
  // Two queries: retry path (below max) and fail path (at max).
  // Separate queries let each be a simple UPDATE RETURNING with no CASE logic.
  // ---------------------------------------------------------------------------

  // Retry: retry_count < MAX_RETRY_COUNT -> reset to 'approved'
  const sendingRetried = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'approved',
      retry_count = retry_count + 1,
      updated_at = ${now}
    WHERE status = 'sending'
      AND updated_at < ${threshold}
      AND retry_count < ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.sendingRetried = sendingRetried.rows.length;

  // Fail: retry_count >= MAX_RETRY_COUNT -> terminal 'failed'
  const sendingFailed = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'failed',
      updated_at = ${now}
    WHERE status = 'sending'
      AND updated_at < ${threshold}
      AND retry_count >= ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.sendingFailed = sendingFailed.rows.length;

  if (sendingFailed.rows.length > 0) {
    for (const row of sendingFailed.rows) {
      console.error(
        `[reap] message ${row.id} (tenant ${row.tenant_id}) permanently failed: ` +
          `stuck in 'sending' after ${MAX_RETRY_COUNT} retries`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Recover 'generating' messages (stuck Brain decision)
  // ---------------------------------------------------------------------------

  // Retry: retry_count < MAX_RETRY_COUNT -> reset to 'pending_generation'
  const generatingRetried = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'pending_generation',
      retry_count = retry_count + 1,
      updated_at = ${now}
    WHERE status = 'generating'
      AND updated_at < ${threshold}
      AND retry_count < ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.generatingRetried = generatingRetried.rows.length;

  // Fail: retry_count >= MAX_RETRY_COUNT -> terminal 'failed'
  const generatingFailed = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'failed',
      updated_at = ${now}
    WHERE status = 'generating'
      AND updated_at < ${threshold}
      AND retry_count >= ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.generatingFailed = generatingFailed.rows.length;

  if (generatingFailed.rows.length > 0) {
    for (const row of generatingFailed.rows) {
      console.error(
        `[reap] message ${row.id} (tenant ${row.tenant_id}) permanently failed: ` +
          `stuck in 'generating' after ${MAX_RETRY_COUNT} retries`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Recover 'awaiting_content' messages (stuck draft / value gate / process crash)
  //
  // 'awaiting_content' is entered after decide() succeeds. The draft call,
  // budget check, assess call, or a process crash between those steps can leave
  // the row here with nothing to recover it. Reap resets to 'pending_generation'
  // so the full pipeline re-runs (fresh decide + draft + assess). The same
  // retry ceiling applies, ensuring permanent failures terminate rather than loop.
  // ---------------------------------------------------------------------------

  // Retry: retry_count < MAX_RETRY_COUNT -> reset to 'pending_generation'
  const awaitingContentRetried = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'pending_generation',
      retry_count = retry_count + 1,
      updated_at = ${now}
    WHERE status = 'awaiting_content'
      AND updated_at < ${threshold}
      AND retry_count < ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.awaitingContentRetried = awaitingContentRetried.rows.length;

  // Fail: retry_count >= MAX_RETRY_COUNT -> terminal 'failed'
  const awaitingContentFailed = await db.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE lifecycle_messages
    SET
      status = 'failed',
      updated_at = ${now}
    WHERE status = 'awaiting_content'
      AND updated_at < ${threshold}
      AND retry_count >= ${MAX_RETRY_COUNT}
      ${tenantFilter}
    RETURNING id, tenant_id
  `);

  stats.awaitingContentFailed = awaitingContentFailed.rows.length;

  if (awaitingContentFailed.rows.length > 0) {
    for (const row of awaitingContentFailed.rows) {
      console.error(
        `[reap] message ${row.id} (tenant ${row.tenant_id}) permanently failed: ` +
          `stuck in 'awaiting_content' after ${MAX_RETRY_COUNT} retries`,
      );
    }
  }

  return stats;
}
