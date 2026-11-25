/**
 * Queries used by packages/worker/src/scan-step-advancement.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-step-advancement.ts (Postgres) and, later,
 * ../d1/worker-scan-step-advancement.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** An active membership as the step-advancement scan reads it. */
export interface WorkerStepAdvancementMembershipRow {
  id: string;
  contactId: string;
  flowId: string;
  currentStep: number;
  enteredAt: Date;
  conditionError: string | null;
}

/** A scan checkpoint row. */
export interface WorkerStepAdvancementCheckpoint {
  lastId: string;
  startedAt: Date;
  discardCount: number;
}

export interface WorkerScanStepAdvancementQueries {
  /** All tenant ids, ordered by id. */
  listTenantIds(): Promise<string[]>;
  /** The checkpoint for (phase, tenant), or null. */
  getCheckpoint(input: { phase: string; tenantId: string }): Promise<WorkerStepAdvancementCheckpoint | null>;
  /** Reset a stale checkpoint: cursor to the zero UUID, started_at = now, discard_count set. */
  resetCheckpoint(input: { phase: string; tenantId: string; now: Date; discardCount: number }): Promise<void>;
  /** Create the checkpoint for (phase, tenant) at the zero UUID (no-op if it already exists). */
  createCheckpoint(input: { phase: string; tenantId: string; now: Date }): Promise<void>;
  /** Move the checkpoint cursor. */
  saveCheckpointCursor(input: { phase: string; tenantId: string; lastId: string }): Promise<void>;
  /** Delete the checkpoint (full pass completed). */
  deleteCheckpoint(input: { phase: string; tenantId: string }): Promise<void>;
  /** One keyset page (by id, after afterId) of the tenant's active memberships. */
  listActiveMembershipsPage(input: {
    tenantId: string;
    afterId: string | null;
    limit: number;
  }): Promise<WorkerStepAdvancementMembershipRow[]>;
  /** A flow's status and raw compiled_plan, or null when the flow does not exist. */
  getFlowPlan(flowId: string): Promise<{ status: string | null; compiledPlan: unknown } | null>;
  /** A contact's lifecycle_state, or null when the contact does not exist. */
  getContactLifecycleState(contactId: string): Promise<string | null>;
  /** Whether the contact has an event with this name at or after `since` (event timestamp). */
  hasEventSince(input: { contactId: string; eventName: string; since: Date }): Promise<boolean>;
  /** Set (or clear with null) a membership's condition_error. */
  setConditionError(input: { membershipId: string; conditionError: string | null }): Promise<void>;
  /**
   * Exit a membership (CAS on status = active) with the given reason;
   * clears condition_error too when clearConditionError is set.
   */
  exitMembership(input: {
    membershipId: string;
    now: Date;
    exitReason: string;
    clearConditionError: boolean;
  }): Promise<void>;
  /**
   * Complete a membership regardless of its current step (CAS on
   * status = active); clears condition_error when clearConditionError is set.
   */
  completeMembership(input: { membershipId: string; now: Date; clearConditionError: boolean }): Promise<void>;
  /**
   * Complete a membership at `step` (CAS on status = active and
   * current_step = step). Returns whether the row was updated.
   */
  completeMembershipAtStep(input: {
    membershipId: string;
    step: number;
    now: Date;
    clearConditionError: boolean;
  }): Promise<boolean>;
  /**
   * Advance a membership from `fromStep` to fromStep + 1 (CAS on
   * status = active and current_step = fromStep, so concurrent callers
   * advance at most once). Returns whether the row was updated.
   */
  advanceMembershipStep(input: {
    membershipId: string;
    fromStep: number;
    clearConditionError: boolean;
  }): Promise<boolean>;
  /** created_at of the membership's message for a step, or null when there is none. */
  getStepMessageCreatedAt(input: { membershipId: string; stepOrder: number }): Promise<Date | null>;
  /**
   * Create the pending_generation message for a membership step (ON CONFLICT
   * DO NOTHING on the (membership, step) unique index, crash-safe
   * idempotency). Returns the new id, or null when the message already existed.
   */
  createStepMessage(input: {
    tenantId: string;
    contactId: string;
    flowId: string;
    membershipId: string;
    stepOrder: number;
    actionType: string;
  }): Promise<string | null>;
}
