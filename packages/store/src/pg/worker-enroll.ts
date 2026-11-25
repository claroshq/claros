/**
 * Postgres implementation of the queries used by packages/worker/src/enroll.ts.
 *
 * The enrollment guard order:
 *   1. Suppression check (contact's email in suppressions table)
 *   2. Class-based concurrency (nurture: one active at a time, with priority eviction)
 *   3. Re-entry policy check
 *   4. INSERT with ON CONFLICT DO NOTHING (race backstop)
 *
 * Concurrency: the entire enrollment sequence for a contact is serialized
 * via pg_advisory_xact_lock (transaction-scoped, auto-released on crash).
 * The guards interleave reads, the eviction write and the insert, so the
 * whole sequence (including its small pure decision logic from @claros/core)
 * runs inside the one transaction here.
 */
import { eq, and, sql, desc, ne } from "drizzle-orm";
import {
  contacts,
  flows,
  flowMemberships,
  suppressions,
} from "@claros/db/schema";
import {
  sortByPriority,
  isReentryAllowed,
  contactEnrollmentLockKey,
  type EnrollableFlow,
  type PriorMembership,
} from "@claros/core";
import type { PgDb } from "./db.js";
import type { WorkerEnrollQueries, WorkerEnrollResult } from "../areas/worker-enroll.js";

interface EnrollmentCandidate {
  flow: EnrollableFlow;
  tenantId: string;
  contactId: string;
}

/**
 * Attempt to enroll a contact into a single flow, running all guards.
 *
 * MUST be called inside the transaction that has already acquired the
 * advisory lock for the contact.
 */
async function attemptEnrollment(
  db: PgDb,
  candidate: EnrollmentCandidate,
  now: Date,
): Promise<WorkerEnrollResult> {
  const { flow, tenantId, contactId } = candidate;

  // Guard 1: Suppression check
  // Only meaningful if the contact has an email. A contact without an email
  // cannot be suppressed (nothing to check against) but also cannot receive
  // email - step advancement (12c) will handle that. Enrollment proceeds.
  const contactRows = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const contactEmail = contactRows[0]?.email;
  if (contactEmail) {
    const suppressed = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.tenantId, tenantId),
          eq(suppressions.email, contactEmail),
        ),
      )
      .limit(1);

    if (suppressed.length > 0) {
      return { enrolled: false, reason: "suppressed" };
    }
  }

  // Guard 2: Class-based concurrency
  let evictedMembershipId: string | undefined;

  if (flow.flowClass === "nurture") {
    // Check for an existing active nurture-class membership for this contact.
    // We need to join flow_memberships with flows to check flow_class.
    const activeMemberships = await db
      .select({
        membershipId: flowMemberships.id,
        flowId: flowMemberships.flowId,
        flowPriority: flows.priority,
      })
      .from(flowMemberships)
      .innerJoin(flows, eq(flowMemberships.flowId, flows.id))
      .where(
        and(
          eq(flowMemberships.contactId, contactId),
          eq(flowMemberships.status, "active"),
          eq(flows.flowClass, "nurture"),
        ),
      );

    if (activeMemberships.length > 0) {
      // There is already an active nurture membership
      const existing = activeMemberships[0]!;
      const existingPriority = existing.flowPriority ?? 0;

      if (existingPriority >= flow.priority) {
        // Existing flow has equal or higher priority - do not enter
        // Tie-break: existing wins (already running)
        return {
          enrolled: false,
          reason: `nurture_concurrency:existing_priority_${existingPriority}_>=_new_${flow.priority}`,
        };
      }

      // New flow has higher priority - evict the existing membership.
      // CAS on status='active': defense-in-depth against a future code path
      // that exits the membership outside the advisory lock scope.
      await db
        .update(flowMemberships)
        .set({
          status: "exited",
          exitedAt: now,
          exitReason: "priority_override",
        })
        .where(
          and(
            eq(flowMemberships.id, existing.membershipId),
            eq(flowMemberships.status, "active"),
          ),
        );

      evictedMembershipId = existing.membershipId;
    }
  }
  // Critical class: no concurrency limit, skip guard 2.

  // Guard 3: Re-entry policy
  // Find the most recent non-active membership for this (contact, flow).
  const priorMemberships = await db
    .select({
      exitedAt: flowMemberships.exitedAt,
      completedAt: flowMemberships.completedAt,
      exitReason: flowMemberships.exitReason,
    })
    .from(flowMemberships)
    .where(
      and(
        eq(flowMemberships.contactId, contactId),
        eq(flowMemberships.flowId, flow.id),
        ne(flowMemberships.status, "active"),
      ),
    )
    .orderBy(desc(flowMemberships.enteredAt))
    .limit(1);

  const priorMembership: PriorMembership | null =
    priorMemberships.length > 0
      ? {
          exitedAt: priorMemberships[0]!.exitedAt,
          completedAt: priorMemberships[0]!.completedAt,
          exitReason: priorMemberships[0]!.exitReason,
        }
      : null;

  if (
    !isReentryAllowed(
      flow.reentryPolicy as "once" | "cooldown" | "every_time",
      flow.reentryCooldownDays,
      priorMembership,
      now,
    )
  ) {
    return { enrolled: false, reason: "reentry_blocked" };
  }

  // Guard 4: INSERT with ON CONFLICT DO NOTHING (race backstop)
  // The partial unique index uq_flow_membership_active on (contact_id, flow_id)
  // WHERE status = 'active' prevents duplicate active memberships for the same flow.
  const inserted = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId: flow.id,
      currentStep: 1,
      status: "active",
      enteredAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: flowMemberships.id });

  if (inserted.length === 0) {
    // ON CONFLICT fired: another process already enrolled this contact
    return { enrolled: false, reason: "concurrent_enrollment" };
  }

  return {
    enrolled: true,
    membershipId: inserted[0]!.id,
    evictedMembershipId,
  };
}

export function pgWorkerEnroll(db: PgDb): WorkerEnrollQueries {
  return {
    async enrollContactInFlows({ contactId, tenantId, candidateFlows, now }) {
      return db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as PgDb;
        if (candidateFlows.length === 0) return [];

        const sorted = sortByPriority(candidateFlows);
        const results: WorkerEnrollResult[] = [];

        // Separate critical and nurture flows
        const criticalFlows = sorted.filter((f) => f.flowClass === "critical");
        const nurtureFlows = sorted.filter((f) => f.flowClass === "nurture");

        // Execute inside a transaction with advisory lock
        // The advisory lock serializes enrollment decisions for this contact
        // across all concurrent callers (scan, trigger-check, overlapping scans).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${sql.raw(contactEnrollmentLockKey(contactId).toString() + "::bigint")})`
        );

        // Enroll all critical flows (no concurrency limit)
        for (const flow of criticalFlows) {
          const result = await attemptEnrollment(
            tx,
            { flow, tenantId, contactId },
            now,
          );
          results.push(result);
        }

        // Enroll only the highest-priority nurture flow (class-based concurrency)
        // The sorted order guarantees the first one is highest priority.
        // If it fails (suppression, re-entry), try the next one.
        let nurtureEnrolled = false;
        for (const flow of nurtureFlows) {
          if (nurtureEnrolled) {
            results.push({ enrolled: false, reason: "nurture_concurrency:higher_priority_enrolled" });
            continue;
          }
          const result = await attemptEnrollment(
            tx,
            { flow, tenantId, contactId },
            now,
          );
          results.push(result);
          if (result.enrolled) {
            nurtureEnrolled = true;
          }
          // If the nurture flow was not enrolled due to suppression or re-entry,
          // try the next nurture flow in priority order. But if it was blocked by
          // nurture_concurrency (existing membership with higher priority), stop -
          // no lower-priority flow can succeed either.
          if (!result.enrolled && result.reason.startsWith("nurture_concurrency:existing_priority")) {
            // Existing membership with higher priority blocks all nurture candidates
            for (let i = nurtureFlows.indexOf(flow) + 1; i < nurtureFlows.length; i++) {
              results.push({ enrolled: false, reason: result.reason });
            }
            break;
          }
        }

        return results;
      });
    },
  };
}
