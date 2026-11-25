/**
 * Queries used by packages/worker/src/date-flows.ts (G3 date triggers and
 * schedules, step expiry). Implementations: ../pg/worker-dates.ts and
 * ../d1/worker-dates.ts. Plain values in and out (Date for timestamps).
 */
import type { ContactConditionQueries } from "./shared-conditions.js";

export interface WorkerDateFlowRow {
  id: string;
  tenantId: string;
  priority: number | null;
  triggerType: string;
  triggerConfig: unknown;
  flowClass: string | null;
  reentryPolicy: string | null;
  reentryCooldownDays: number | null;
}

export interface WorkerDateCandidate {
  contactId: string;
  /** The contact's current value of the anchor date trait. */
  value: Date;
  /** The contact's `timezone` trait, or null. */
  timezone: string | null;
}

export interface WorkerDatesQueries extends ContactConditionQueries {
  /** Tenants (id, settings), all or the given ones, ordered by id. */
  listTenants(tenantIds?: string[]): Promise<Array<{ id: string; settings: unknown }>>;
  /** The tenant's settings JSON, or null. */
  getTenantSettings(tenantId: string): Promise<Record<string, unknown> | null>;
  /** Active, compiled flows of the tenant with a date_property or date_schedule trigger. */
  listActiveDateFlows(tenantId: string): Promise<WorkerDateFlowRow[]>;
  /**
   * Active memberships of a date flow whose anchor no longer equals the
   * contact's current date trait (moved or removed), at most `limit`.
   */
  listStaleMemberships(input: { tenantId: string; flowId: string; property: string; limit: number }): Promise<Array<{ membershipId: string; contactId: string }>>;
  /**
   * Contacts whose `property` date lies in [from, to] and who have no
   * membership of this flow for that exact anchor value (any status).
   * Keyset page by contact id.
   */
  listDueCandidates(input: {
    tenantId: string;
    flowId: string;
    property: string;
    from: Date;
    to: Date;
    afterContactId: string | null;
    limit: number;
  }): Promise<WorkerDateCandidate[]>;
  /** The contact's indexed value of a date trait, or null. */
  getContactDate(input: { tenantId: string; contactId: string; property: string }): Promise<Date | null>;
  /**
   * Exit an active membership whose anchor moved (CAS on status active) and
   * cancel its unsent messages (pending_generation, awaiting_content,
   * pending_approval, approved) with status_reason = reason, in one atomic
   * unit, writing flow.exited. Returns whether the membership was exited.
   */
  exitStaleMembership(input: {
    tenantId: string;
    membershipId: string;
    contactId: string;
    flowId: string;
    reason: string;
    now: Date;
  }): Promise<boolean>;
  /** Move an active membership from step fromStep to toStep (CAS). */
  jumpMembershipStep(input: { membershipId: string; fromStep: number; toStep: number }): Promise<boolean>;
  /**
   * Cancel unsent messages (pending_generation, awaiting_content,
   * pending_approval, approved) whose expires_at is before now, status_reason
   * 'expired', at most `limit`. Returns the cancelled rows.
   */
  cancelExpiredMessages(input: { now: Date; limit: number }): Promise<Array<{ id: string; tenantId: string }>>;
}
