/**
 * Scan phase 2: flow enrollment for lifecycle-transition triggers.
 *
 * Called AFTER phaseTimeTransitions (phase 1), which provides the list of
 * transitions that just fired. For each transition, finds active flows whose
 * trigger_config matches {from, to}, then runs the enrollment sequence.
 *
 * This phase does NOT paginate the contact table. Its input is bounded by
 * the number of transitions phase 1 applied (typically O(10s) per scan run).
 * No checkpoint is needed.
 *
 * Segment-triggered flows enroll in phase 2b (scan-segment-enrollment.ts),
 * not here: this phase only handles lifecycle_transition triggers.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  matchesLifecycleTransition,
  type EnrollableFlow,
} from "@claros/core";
import { enrollContactInFlows } from "./enroll.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/**
 * A lifecycle transition that was applied in phase 1.
 * Used as input to phase 2 enrollment.
 */
export interface AppliedTransition {
  tenantId: string;
  contactId: string;
  fromState: string;
  toState: string;
}

export interface PhaseEnrollmentResult {
  transitionsEvaluated: number;
  enrollmentsAttempted: number;
  enrollmentsSucceeded: number;
  evictions: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 2 of the scan: enroll contacts into lifecycle-transition-triggered
 * flows based on transitions that phase 1 just applied.
 *
 * For each transition:
 *   1. Load active, compiled flows for the tenant with trigger_type = 'lifecycle_transition'
 *   2. Filter to flows whose trigger_config matches {from, to}
 *   3. Run enrollment guards via enrollContactInFlows (advisory-locked)
 */
export async function phaseEnrollment(
  db: Db,
  transitions: AppliedTransition[],
  now: Date,
): Promise<PhaseEnrollmentResult> {
  const stats: PhaseEnrollmentResult = {
    transitionsEvaluated: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    evictions: 0,
  };

  if (transitions.length === 0) return stats;

  // Group transitions by tenant to batch flow queries
  const byTenant = new Map<string, AppliedTransition[]>();
  for (const t of transitions) {
    const arr = byTenant.get(t.tenantId) ?? [];
    arr.push(t);
    byTenant.set(t.tenantId, arr);
  }

  for (const [tenantId, tenantTransitions] of byTenant) {
    // Load all active, compiled lifecycle-transition flows for this tenant.
    // Small cardinality: a tenant typically has < 50 flows total.
    const tenantFlows =
      await storeFor(db).workerScanEnrollment.listActiveLifecycleTransitionFlows(tenantId);

    for (const transition of tenantTransitions) {
      stats.transitionsEvaluated++;

      // Find flows whose trigger_config matches this transition
      const matchingFlows: EnrollableFlow[] = tenantFlows
        .filter((f) =>
          matchesLifecycleTransition(
            f as EnrollableFlow,
            transition.fromState,
            transition.toState,
          ),
        )
        .map((f) => ({
          id: f.id,
          tenantId: f.tenantId,
          priority: f.priority ?? 0,
          triggerType: f.triggerType as "lifecycle_transition",
          triggerConfig: f.triggerConfig,
          flowClass: (f.flowClass ?? "nurture") as "critical" | "nurture",
          reentryPolicy: (f.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
          reentryCooldownDays: f.reentryCooldownDays ?? 30,
        }));

      if (matchingFlows.length === 0) continue;

      stats.enrollmentsAttempted += matchingFlows.length;

      // Enroll within a transaction (enrollContactInFlows opens it and
      // acquires the advisory lock inside)
      const results = await enrollContactInFlows(
        db,
        transition.contactId,
        tenantId,
        matchingFlows,
        now,
      );

      for (const result of results) {
        if (result.enrolled) {
          stats.enrollmentsSucceeded++;
          if (result.evictedMembershipId) {
            stats.evictions++;
          }
        }
      }
    }
  }

  return stats;
}
