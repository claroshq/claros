/**
 * Queries used by packages/worker/src/reap.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-reap.ts (Postgres) and, later,
 * ../d1/worker-reap.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Statuses a message can be stuck in. */
export type WorkerReapStuckStatus = "sending" | "generating" | "awaiting_content";

/** Status a retried stuck message is reset to. */
export type WorkerReapRetryStatus = "approved" | "pending_generation";

export interface WorkerReapStuckInput {
  /** Status the message is stuck in (CAS: must still be this status). */
  stuckStatus: WorkerReapStuckStatus;
  /** Only messages with updated_at older than this are touched. */
  threshold: Date;
  now: Date;
  maxRetryCount: number;
  /** Optional tenant scope; omitted or empty means all tenants. */
  tenantIds?: string[];
}

/** A reaped message. */
export interface WorkerReapedMessage {
  id: string;
  tenant_id: string;
}

export interface WorkerReapQueries {
  /**
   * CAS stuckStatus -> retryStatus, retry_count + 1, for stuck messages below maxRetryCount.
   * Returns the rows this call updated.
   */
  retryStuckMessages(
    input: WorkerReapStuckInput & { retryStatus: WorkerReapRetryStatus },
  ): Promise<WorkerReapedMessage[]>;
  /** CAS stuckStatus -> failed for stuck messages at or above maxRetryCount. Returns the rows this call updated. */
  failStuckMessages(input: WorkerReapStuckInput): Promise<WorkerReapedMessage[]>;
}
