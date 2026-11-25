/**
 * Queries used by packages/worker/src/enroll.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-enroll.ts (Postgres) and, later,
 * ../d1/worker-enroll.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
import type { EnrollableFlow } from "@claros/core";

/** Outcome of one enrollment attempt (one candidate flow). */
export type WorkerEnrollResult =
  | { enrolled: true; membershipId: string; evictedMembershipId?: string }
  | { enrolled: false; reason: string };

export interface WorkerEnrollQueries {
  /**
   * Run the full enrollment sequence for one contact against candidate flows,
   * as one atomic unit: suppression check, class-based concurrency (nurture:
   * one active membership per contact, with priority eviction), re-entry
   * policy, and the membership INSERT (ON CONFLICT DO NOTHING backstop).
   *
   * Guarantee: enrollment decisions for a contact are serialized across all
   * concurrent callers (Postgres: transaction plus pg_advisory_xact_lock on
   * the contact), so a contact never ends up in two active nurture flows.
   * Returns one result per candidate, critical flows first, then nurture
   * flows in priority order.
   */
  enrollContactInFlows(input: {
    contactId: string;
    tenantId: string;
    candidateFlows: EnrollableFlow[];
    now: Date;
  }): Promise<WorkerEnrollResult[]>;
}
