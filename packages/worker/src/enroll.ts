/**
 * Shared enrollment logic: guards, eviction, and membership insertion.
 *
 * Used by scan-enrollment.ts (lifecycle-transition triggers),
 * scan-segment-enrollment.ts (segment triggers) and trigger-check.ts (event
 * triggers). The I/O-bearing enrollment sequence runs in the Store
 * (workerEnroll.enrollContactInFlows) inside one transaction with an
 * advisory lock.
 *
 * The enrollment guard order:
 *   1. Suppression check (contact's email in suppressions table)
 *   2. Class-based concurrency (nurture: one active at a time, with priority eviction)
 *   3. Re-entry policy check
 *   4. INSERT with ON CONFLICT DO NOTHING (race backstop)
 *
 * Concurrency: the entire enrollment sequence for a contact is serialized
 * via pg_advisory_xact_lock (transaction-scoped, auto-released on crash).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import type { EnrollableFlow } from "@claros/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface EnrollmentCandidate {
  /** The flow to potentially enroll the contact in. */
  flow: EnrollableFlow;
  /** tenant_id (denormalized for convenience). */
  tenantId: string;
  /** The contact to enroll. */
  contactId: string;
}

export type EnrollmentResult =
  | { enrolled: true; membershipId: string; evictedMembershipId?: string }
  | { enrolled: false; reason: string };

// ---------------------------------------------------------------------------
// Enrollment with advisory lock (transaction wrapper)
// ---------------------------------------------------------------------------

/**
 * Enroll a contact into eligible flows, wrapped in a transaction with an
 * advisory lock on the contact ID to prevent nurture-concurrency races.
 * The transaction is opened by the Store method; callers pass the plain
 * database handle (not a transaction).
 *
 * Accepts a list of candidate flows (already filtered by trigger match and
 * compile_status). Sorts by priority, and for nurture class only enrolls
 * the highest-priority flow (the rest are losers-not-entered). For critical
 * class, enrolls all eligible flows.
 *
 * Returns results for all candidates.
 */
export async function enrollContactInFlows(
  db: Db,
  contactId: string,
  tenantId: string,
  candidateFlows: EnrollableFlow[],
  now: Date,
  /** Date triggers (G3): the anchor value this enrollment is for. */
  anchorAt: Date | null = null,
  /** P5b: properties of the triggering event ({{event.*}} in templates). */
  triggerProperties: Record<string, unknown> | null = null,
): Promise<EnrollmentResult[]> {
  if (candidateFlows.length === 0) return [];

  return storeFor(db).workerEnroll.enrollContactInFlows({
    contactId,
    tenantId,
    candidateFlows,
    now,
    anchorAt,
    triggerProperties,
  });
}
