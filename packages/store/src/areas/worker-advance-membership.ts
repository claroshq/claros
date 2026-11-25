/**
 * Queries used by packages/worker/src/advance-membership.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-advance-membership.ts (Postgres) and, later,
 * ../d1/worker-advance-membership.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** The membership fields targeted step advancement reads. */
import type { ContactConditionQueries } from "./shared-conditions.js";
import type { OutboxEntry } from "./shared-outbox.js";

export interface WorkerAdvanceMembershipRow {
  id: string;
  contactId: string;
  flowId: string;
  currentStep: number;
  enteredAt: Date;
  conditionError: string | null;
  status: string;
}

export interface WorkerAdvanceMembershipQueries extends ContactConditionQueries {
  /** A membership by id, tenant-scoped, or null. */
  getMembership(input: { tenantId: string; membershipId: string }): Promise<WorkerAdvanceMembershipRow | null>;
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
    /** Outbox entries (G5: flow.exited) written with the exit when it happens. */
    events?: { tenantId: string; outbox: OutboxEntry[] };
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
   * DO NOTHING on the (membership, step) unique index). Returns the new id,
   * or null when the message already existed.
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
