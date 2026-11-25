/**
 * Event-trigger flow enrollment job handler.
 *
 * Processes claros.trigger-check jobs enqueued by the ingest route after each
 * track event. Evaluates which active event-triggered flows match the event
 * name, then runs the enrollment sequence for matching flows.
 *
 * This is the second enrollment path (the first is scan-enrollment.ts for
 * lifecycle-transition triggers). Both use the shared enrollContactInFlows
 * function which handles advisory locking and guards.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  matchesEventTrigger,
  type EnrollableFlow,
  type TriggerCheckJobData,
} from "@claros/core";
import { enrollContactInFlows } from "./enroll.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface TriggerCheckResult {
  /** IDs of memberships successfully enrolled. */
  enrolledMembershipIds: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single claros.trigger-check job.
 *
 * Steps:
 *   1. Load active, compiled event-trigger flows for the tenant
 *   2. Filter to flows whose trigger_config.event matches the event name
 *   3. Run enrollment guards via enrollContactInFlows (advisory-locked)
 *
 * Returns the enrolled membership IDs so the caller can chain targeted
 * step-advancement jobs.
 */
export async function handleTriggerCheck(
  data: TriggerCheckJobData,
  db: Db,
): Promise<TriggerCheckResult> {
  const { tenant_id, contact_id, event_name } = data;

  // Load active, compiled event-trigger flows for this tenant
  const tenantFlows = await storeFor(db).workerTriggerCheck.listActiveEventFlows(tenant_id);

  // Filter to flows matching this event name
  const matchingFlows: EnrollableFlow[] = tenantFlows
    .filter((f) =>
      matchesEventTrigger(f as EnrollableFlow, event_name),
    )
    .map((f) => ({
      id: f.id,
      tenantId: f.tenantId,
      priority: f.priority ?? 0,
      triggerType: f.triggerType as "event",
      triggerConfig: f.triggerConfig,
      flowClass: (f.flowClass ?? "nurture") as "critical" | "nurture",
      reentryPolicy: (f.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
      reentryCooldownDays: f.reentryCooldownDays ?? 30,
    }));

  if (matchingFlows.length === 0) return { enrolledMembershipIds: [] };

  // Enroll within a transaction (enrollContactInFlows opens it and acquires
  // the advisory lock inside)
  const now = new Date();
  const results = await enrollContactInFlows(
    db,
    contact_id,
    tenant_id,
    matchingFlows,
    now,
  );

  // Collect successfully enrolled membership IDs
  const enrolledMembershipIds = results
    .filter((r) => r.enrolled)
    .map((r) => (r as { enrolled: true; membershipId: string }).membershipId);

  return { enrolledMembershipIds };
}
