/**
 * Scan phase 3: step advancement and message creation.
 *
 * Iterates all active flow memberships (checkpointed per-tenant), determines
 * whether the current step's delay has elapsed, evaluates conditions, creates
 * lifecycle_messages rows (status: pending_generation), advances current_step,
 * and completes the membership when steps run out.
 *
 * Key behaviors:
 *   - Delay for step 1 counts from membership.entered_at.
 *   - Delay for step N counts from when step N-1's message row was created.
 *   - Plan-level exit_conditions are evaluated before delay/step logic.
 *   - Step-level conditions are proceed-if gates evaluated after delay elapses.
 *   - Step-level exit_conditions fire an early exit if true after delay elapses.
 *   - Unrecognized condition shapes: membership stays active, unadvanced,
 *     condition_error recorded. Self-clears on next pass if the flow is recompiled.
 *   - If the flow is archived: exit the membership with reason "flow_archived".
 *   - If the flow is paused or compiled_plan is null: skip (recoverable state).
 *   - Crash-safe: unique index on (membership_id, flow_step_order) prevents
 *     duplicate messages. If a message exists but current_step was not advanced,
 *     the retry advances it without re-inserting.
 *
 * Checkpoint: uses scan_checkpoints table keyed by ("step_advancement", tenant_id).
 * Each batch updates the checkpoint. A stale checkpoint (older than 30 min) is
 * discarded with discard_count incremented and a warning logged.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { parseDelay, delayToMs, type CompiledStep, type PlanExitCondition,
  cachedConditionContext,
} from "@claros/core";
import {
  evaluateStepCondition,
  evaluatePlanExitCondition,
  formatConditionError,
  type ContactState,
  type EventChecker,
} from "./condition-evaluator.js";
import { stepDateMembership, stepExpiresAt, dateUnchangedCheck } from "./date-flows.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of memberships fetched per keyset page. */
const BATCH_SIZE = 500;

/** Scan phase name for checkpoint keying. */
const PHASE_NAME = "step_advancement";

/** Stale checkpoint threshold: 30 minutes (2x the 15-min scan interval). */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseStepAdvancementResult {
  tenantsProcessed: number;
  membershipsEvaluated: number;
  messagesCreated: number;
  stepsAdvanced: number;
  stepsSkippedCondition: number;
  membershipsCompleted: number;
  membershipsExitedCondition: number;
  membershipsExitedArchived: number;
  membershipsSkippedPaused: number;
  membershipsStuckConditionError: number;
  staleCheckpointsDiscarded: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 3 of the scan: advance steps and create messages for all active
 * memberships. Returns aggregate stats for observability.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed. When omitted, all tenants are processed (production default).
 */
export async function phaseStepAdvancement(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseStepAdvancementResult> {
  const stats: PhaseStepAdvancementResult = {
    tenantsProcessed: 0,
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    stepsSkippedCondition: 0,
    membershipsCompleted: 0,
    membershipsExitedCondition: 0,
    membershipsExitedArchived: 0,
    membershipsSkippedPaused: 0,
    membershipsStuckConditionError: 0,
    staleCheckpointsDiscarded: 0,
  };

  // Load tenants: use provided list or discover all.
  let tenantRows: { id: string }[];
  if (tenantIds && tenantIds.length > 0) {
    tenantRows = tenantIds.map((id) => ({ id }));
  } else {
    tenantRows = (await storeFor(db).workerScanStepAdvancement.listTenantIds()).map((id) => ({ id }));
  }

  for (const tenant of tenantRows) {
    let tenantStats: TenantStepResult;
    try {
      tenantStats = await processTenantStepAdvancement(
        db,
        tenant.id,
        now,
      );
    } catch (err: unknown) {
      // If a tenant is deleted mid-scan, FK violations or missing-row errors
      // can occur on checkpoint insert. Skip gracefully.
      if (isFkViolation(err)) continue;
      throw err;
    }

    stats.membershipsEvaluated += tenantStats.membershipsEvaluated;
    stats.messagesCreated += tenantStats.messagesCreated;
    stats.stepsAdvanced += tenantStats.stepsAdvanced;
    stats.stepsSkippedCondition += tenantStats.stepsSkippedCondition;
    stats.membershipsCompleted += tenantStats.membershipsCompleted;
    stats.membershipsExitedCondition += tenantStats.membershipsExitedCondition;
    stats.membershipsExitedArchived += tenantStats.membershipsExitedArchived;
    stats.membershipsSkippedPaused += tenantStats.membershipsSkippedPaused;
    stats.membershipsStuckConditionError += tenantStats.membershipsStuckConditionError;
    stats.staleCheckpointsDiscarded += tenantStats.staleCheckpointsDiscarded;
    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-tenant processing
// ---------------------------------------------------------------------------

interface TenantStepResult {
  membershipsEvaluated: number;
  messagesCreated: number;
  stepsAdvanced: number;
  stepsSkippedCondition: number;
  membershipsCompleted: number;
  membershipsExitedCondition: number;
  membershipsExitedArchived: number;
  membershipsSkippedPaused: number;
  membershipsStuckConditionError: number;
  staleCheckpointsDiscarded: number;
}

async function processTenantStepAdvancement(
  db: Db,
  tenantId: string,
  now: Date,
): Promise<TenantStepResult> {
  const stats: TenantStepResult = {
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    stepsSkippedCondition: 0,
    membershipsCompleted: 0,
    membershipsExitedCondition: 0,
    membershipsExitedArchived: 0,
    membershipsSkippedPaused: 0,
    membershipsStuckConditionError: 0,
    staleCheckpointsDiscarded: 0,
  };

  // Resolve checkpoint
  let lastId: string | null = null;
  const cp = await storeFor(db).workerScanStepAdvancement.getCheckpoint({ phase: PHASE_NAME, tenantId });

  if (cp !== null) {
    const age = now.getTime() - cp.startedAt.getTime();
    if (age > STALE_THRESHOLD_MS) {
      // Stale checkpoint - discard and start fresh
      const newCount = cp.discardCount + 1;
      await storeFor(db).workerScanStepAdvancement.resetCheckpoint({
        phase: PHASE_NAME,
        tenantId,
        now,
        discardCount: newCount,
      });
      console.warn(
        `[scan] step-advancement: stale checkpoint discarded for tenant ${tenantId} ` +
          `(started ${age}ms ago, threshold ${STALE_THRESHOLD_MS}ms). ` +
          `Phase did not complete in previous run. discard_count=${newCount}`,
      );
      stats.staleCheckpointsDiscarded++;
      lastId = null;
    } else {
      lastId = cp.lastId;
    }
  } else {
    // No checkpoint - create one to track this pass
    await storeFor(db).workerScanStepAdvancement.createCheckpoint({ phase: PHASE_NAME, tenantId, now });
  }

  const startTime = Date.now();

  // Flow plan cache: avoid re-fetching the same flow's plan per batch
  const flowPlanCache = new Map<string, {
    status: string;
    plan: CompiledStep[] | null;
    exitConditions: unknown[] | null;
    compiledPlan: unknown;
  }>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Keyset pagination on active memberships for this tenant
    const batch = await storeFor(db).workerScanStepAdvancement.listActiveMembershipsPage({
      tenantId,
      afterId: lastId,
      limit: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const membership of batch) {
      stats.membershipsEvaluated++;

      // Get flow plan (cached)
      let flowInfo = flowPlanCache.get(membership.flowId);
      if (!flowInfo) {
        const flowRow = await storeFor(db).workerScanStepAdvancement.getFlowPlan(membership.flowId);

        if (flowRow === null) {
          // Flow deleted - should not happen with FK, but defensive. Skip.
          flowInfo = { status: "archived", plan: null, exitConditions: null, compiledPlan: null };
        } else {
          const raw = flowRow;
          const plan = extractSteps(raw.compiledPlan);
          const exitConditions = extractExitConditions(raw.compiledPlan);
          flowInfo = { status: raw.status ?? "draft", plan, exitConditions, compiledPlan: raw.compiledPlan };
        }
        flowPlanCache.set(membership.flowId, flowInfo);
      }

      // Handle archived flow: exit the membership
      if (flowInfo.status === "archived") {
        await storeFor(db).workerScanStepAdvancement.exitMembership({
          membershipId: membership.id,
          now,
          exitReason: "flow_archived",
          clearConditionError: false,
          events: exitEvent(tenantId, membership, "flow_archived"),
        });
        stats.membershipsExitedArchived++;
        continue;
      }

      // Handle paused flow or null plan: skip (recoverable)
      if (flowInfo.status === "paused" || flowInfo.plan === null) {
        stats.membershipsSkippedPaused++;
        continue;
      }

      // -----------------------------------------------------------------------
      // Condition evaluation: build contact state and event checker
      // -----------------------------------------------------------------------

      const lifecycleState = await storeFor(db).workerScanStepAdvancement.getContactLifecycleState(membership.contactId);

      if (lifecycleState === null) {
        // Contact deleted mid-scan. Skip.
        continue;
      }

      const contactState: ContactState = {
        lifecycleState,
      };

      const eventChecker: EventChecker = {
        async hasEventSince(eventName: string, since: Date): Promise<boolean> {
          return storeFor(db).workerScanStepAdvancement.hasEventSince({
            contactId: membership.contactId,
            eventName,
            since,
          });
        },
        contact: cachedConditionContext({
          now,
          traits: async () =>
            (await storeFor(db).workerScanStepAdvancement.getContactTraits({ tenantId, contactId: membership.contactId })) ?? {},
          countSends: (f) =>
            storeFor(db).workerScanStepAdvancement.countSends({ tenantId, contactId: membership.contactId, ...f }),
          lifecycleState: () => storeFor(db).workerScanStepAdvancement.lookupLifecycleState({ tenantId, contactId: membership.contactId }),
        }),
        dateUnchanged: dateUnchangedCheck(db, tenantId, membership, flowInfo.compiledPlan),
      };

      // -----------------------------------------------------------------------
      // Plan-level exit conditions: evaluate before step logic
      // -----------------------------------------------------------------------

      if (flowInfo.exitConditions && flowInfo.exitConditions.length > 0) {
        let exitFired = false;
        let conditionErrorMsg: string | null = null;

        for (const ec of flowInfo.exitConditions) {
          const result = await evaluatePlanExitCondition(
            ec,
            contactState,
            eventChecker,
            membership.enteredAt,
          );

          if (result.outcome === "unknown_shape") {
            conditionErrorMsg = formatConditionError(
              { type: "plan_exit" },
              result.message,
            );
            break;
          }

          if (result.outcome === "pass") {
            exitFired = true;
            break;
          }
          // "fail" - continue checking next exit condition
        }

        if (conditionErrorMsg !== null) {
          // Record the error only if it differs from what is already stored
          if (membership.conditionError !== conditionErrorMsg) {
            await storeFor(db).workerScanStepAdvancement.setConditionError({
              membershipId: membership.id,
              conditionError: conditionErrorMsg,
            });
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (exitFired) {
          // Clear condition_error if present (the plan is now valid)
          await storeFor(db).workerScanStepAdvancement.exitMembership({
            membershipId: membership.id,
            now,
            exitReason: "condition_met",
            clearConditionError: membership.conditionError !== null,
            events: exitEvent(tenantId, membership, "condition_met"),
          });
          stats.membershipsExitedCondition++;
          continue;
        }
      }

      // -----------------------------------------------------------------------
      // Date triggers (G3): stale anchors exit; schedules advance by slot.
      // -----------------------------------------------------------------------

      if (membership.anchorAt) {
        const dated = await stepDateMembership(db, {
          tenantId,
          membership,
          compiledPlan: flowInfo.compiledPlan,
          steps: flowInfo.plan,
          now,
          contactState,
          eventChecker,
          ops: storeFor(db).workerScanStepAdvancement,
        });
        if (dated.kind !== "not_date") {
          if (dated.kind === "stale_exited" || dated.kind === "exited") stats.membershipsExitedCondition++;
          else if (dated.kind === "completed") stats.membershipsCompleted++;
          else if (dated.kind === "condition_error") stats.membershipsStuckConditionError++;
          else if (dated.kind === "skipped") {
            if (dated.completed) stats.membershipsCompleted++;
            else stats.stepsSkippedCondition++;
          } else if (dated.kind === "message") {
            if (dated.messageId !== null) stats.messagesCreated++;
            if (dated.completed) stats.membershipsCompleted++;
            if (dated.advanced) stats.stepsAdvanced++;
          }
          continue;
        }
      }

      // -----------------------------------------------------------------------
      // Step logic: find step, compute delay, evaluate step conditions
      // -----------------------------------------------------------------------

      const steps = flowInfo.plan;
      const currentStepDef = steps.find((s) => s.order === membership.currentStep);
      if (!currentStepDef) {
        // Step not found in plan - plan may have been re-compiled with fewer steps.
        // Complete the membership (no more work to do).
        await storeFor(db).workerScanStepAdvancement.completeMembership({
          membershipId: membership.id,
          now,
          clearConditionError: membership.conditionError !== null,
        });
        stats.membershipsCompleted++;
        continue;
      }

      // Determine delay reference time:
      //   Step 1: membership.entered_at
      //   Step N: created_at of step N-1's message row (or entered_at if skipped)
      let referenceTime: Date;
      if (membership.currentStep === 1) {
        referenceTime = membership.enteredAt;
      } else {
        // Find the most recent message for a prior step (may have been skipped)
        const prevCreatedAt = await storeFor(db).workerScanStepAdvancement.getStepMessageCreatedAt({
          membershipId: membership.id,
          stepOrder: membership.currentStep - 1,
        });

        if (prevCreatedAt === null) {
          // No previous message found - the previous step was skipped by condition.
          // Use entered_at as fallback (the delay will have elapsed).
          referenceTime = membership.enteredAt;
        } else {
          referenceTime = prevCreatedAt;
        }
      }

      // Parse delay and check if elapsed
      const parsed = parseDelay(currentStepDef.delay);
      if (parsed === null) {
        // Invalid delay format in the plan - skip this membership.
        // This should not happen (compilation validates delays), but defensive.
        continue;
      }

      const delayMs = delayToMs(parsed);
      const elapsed = now.getTime() - referenceTime.getTime();
      if (elapsed < delayMs) {
        // Delay not yet elapsed - skip. Clear condition_error if it was set
        // (we got past exit conditions successfully, so plan is valid now).
        if (membership.conditionError !== null) {
          await storeFor(db).workerScanStepAdvancement.setConditionError({
            membershipId: membership.id,
            conditionError: null,
          });
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // Delay elapsed: evaluate step-level exit_condition
      // -----------------------------------------------------------------------

      if (currentStepDef.exit_condition !== undefined) {
        const exitResult = await evaluateStepCondition(
          currentStepDef.exit_condition,
          contactState,
          eventChecker,
          referenceTime,
        );

        if (exitResult.outcome === "unknown_shape") {
          const errMsg = formatConditionError(
            { type: "step_exit_condition", stepOrder: membership.currentStep },
            exitResult.message,
          );
          if (membership.conditionError !== errMsg) {
            await storeFor(db).workerScanStepAdvancement.setConditionError({
              membershipId: membership.id,
              conditionError: errMsg,
            });
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (exitResult.outcome === "pass") {
          // Exit condition fired - exit the membership
          await storeFor(db).workerScanStepAdvancement.exitMembership({
            membershipId: membership.id,
            now,
            exitReason: "condition_met",
            clearConditionError: membership.conditionError !== null,
            events: exitEvent(tenantId, membership, "condition_met"),
          });
          stats.membershipsExitedCondition++;
          continue;
        }
        // "fail" - exit condition not met, proceed with step normally
      }

      // -----------------------------------------------------------------------
      // Delay elapsed: evaluate step-level condition (proceed-if gate)
      // -----------------------------------------------------------------------

      if (currentStepDef.condition !== undefined) {
        const condResult = await evaluateStepCondition(
          currentStepDef.condition,
          contactState,
          eventChecker,
          referenceTime,
        );

        if (condResult.outcome === "unknown_shape") {
          const errMsg = formatConditionError(
            { type: "step_condition", stepOrder: membership.currentStep },
            condResult.message,
          );
          if (membership.conditionError !== errMsg) {
            await storeFor(db).workerScanStepAdvancement.setConditionError({
              membershipId: membership.id,
              conditionError: errMsg,
            });
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (condResult.outcome === "fail") {
          // Condition is false - skip this step (no message), advance to next
          const totalSteps = steps.length;
          const isLastStep = membership.currentStep >= totalSteps;

          if (isLastStep) {
            await storeFor(db).workerScanStepAdvancement.completeMembershipAtStep({
              membershipId: membership.id,
              step: membership.currentStep,
              now,
              clearConditionError: membership.conditionError !== null,
            });
            stats.membershipsCompleted++;
          } else {
            await storeFor(db).workerScanStepAdvancement.advanceMembershipStep({
              membershipId: membership.id,
              fromStep: membership.currentStep,
              clearConditionError: membership.conditionError !== null,
            });
            stats.stepsSkippedCondition++;
          }
          continue;
        }
        // "pass" - condition is true, proceed to create message
      }

      // -----------------------------------------------------------------------
      // All conditions passed: create message and advance step
      // -----------------------------------------------------------------------

      // Clear condition_error if it was set (conditions now evaluated successfully)
      // Use INSERT ... ON CONFLICT DO NOTHING for crash-safe idempotency.
      const insertedId = await storeFor(db).workerScanStepAdvancement.createStepMessage({
        tenantId,
        contactId: membership.contactId,
        flowId: membership.flowId,
        membershipId: membership.id,
        stepOrder: membership.currentStep,
        actionType: currentStepDef.action_type,
        expiresAt: stepExpiresAt(currentStepDef, now),
      });

      if (insertedId !== null) {
        stats.messagesCreated++;
      }
      // Whether or not we just inserted (vs. conflict = already existed from prior crash),
      // advance the step.

      const totalSteps = steps.length;
      const isLastStep = membership.currentStep >= totalSteps;

      if (isLastStep) {
        // Complete the membership
        const completed = await storeFor(db).workerScanStepAdvancement.completeMembershipAtStep({
          membershipId: membership.id,
          step: membership.currentStep,
          now,
          clearConditionError: membership.conditionError !== null,
        });

        if (completed) {
          stats.membershipsCompleted++;
        }
      } else {
        // Advance to next step (CAS on current_step to prevent double-advance)
        const advanced = await storeFor(db).workerScanStepAdvancement.advanceMembershipStep({
          membershipId: membership.id,
          fromStep: membership.currentStep,
          clearConditionError: membership.conditionError !== null,
        });

        if (advanced) {
          stats.stepsAdvanced++;
        }
      }
    }

    // Update checkpoint after each batch
    lastId = batch[batch.length - 1]!.id;
    await storeFor(db).workerScanStepAdvancement.saveCheckpointCursor({ phase: PHASE_NAME, tenantId, lastId });

    // If batch was smaller than BATCH_SIZE, we've exhausted this tenant
    if (batch.length < BATCH_SIZE) break;
  }

  // Full pass completed - delete the checkpoint row (start fresh next run)
  await storeFor(db).workerScanStepAdvancement.deleteCheckpoint({ phase: PHASE_NAME, tenantId });

  const duration = Date.now() - startTime;
  if (stats.membershipsEvaluated > 0) {
    console.log(
      `[scan] step-advancement: full pass completed for tenant ${tenantId} ` +
        `in ${duration}ms (${stats.membershipsEvaluated} memberships)`,
    );
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract steps array from a flow's compiled_plan JSONB value.
 * Returns null if the plan is null or does not contain a valid steps array.
 */
function extractSteps(compiledPlan: unknown): CompiledStep[] | null {
  if (compiledPlan === null || compiledPlan === undefined) return null;
  if (typeof compiledPlan !== "object") return null;
  const plan = compiledPlan as Record<string, unknown>;
  if (!Array.isArray(plan.steps)) return null;
  // Basic structural check - trust that compilation validated the full schema.
  // We need order, delay, action_type, condition, and exit_condition here.
  return plan.steps as CompiledStep[];
}

/**
 * Extract plan-level exit_conditions from a compiled_plan JSONB value.
 * Returns null if absent or not an array.
 */
function extractExitConditions(compiledPlan: unknown): unknown[] | null {
  if (compiledPlan === null || compiledPlan === undefined) return null;
  if (typeof compiledPlan !== "object") return null;
  const plan = compiledPlan as Record<string, unknown>;
  if (!Array.isArray(plan.exit_conditions)) return null;
  if (plan.exit_conditions.length === 0) return null;
  return plan.exit_conditions;
}

/**
 * Check if an error is a Postgres foreign key violation (code 23503).
 * Used to gracefully handle tenants deleted mid-scan.
 * Drizzle may wrap the pg error, so check both the error itself and its cause.
 */
function isFkViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Direct pg error
  if ("code" in err && (err as { code: string }).code === "23503") return true;
  // Drizzle wraps the original error as .cause
  if ("cause" in err) {
    const cause = (err as { cause: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return (cause as { code: string }).code === "23503";
    }
  }
  return false;
}

/** Outbox entry (G5) for a membership exit. */
function exitEvent(tenantId: string, membership: { id: string; contactId: string; flowId: string }, reason: string) {
  return {
    tenantId,
    outbox: [{ event: "flow.exited", payload: { membership_id: membership.id, contact_id: membership.contactId, flow_id: membership.flowId, reason } }],
  };
}
