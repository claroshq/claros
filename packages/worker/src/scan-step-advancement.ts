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
import { eq, and, gt, sql, gte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  tenants,
  contacts,
  events,
  flows,
  flowMemberships,
  lifecycleMessages,
  scanCheckpoints,
} from "@claros/db/schema";
import { parseDelay, delayToMs, type CompiledStep, type PlanExitCondition } from "@claros/core";
import {
  evaluateStepCondition,
  evaluatePlanExitCondition,
  formatConditionError,
  type ContactState,
  type EventChecker,
} from "./condition-evaluator.js";

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
    tenantRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .orderBy(tenants.id);
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
  const checkpoint = await db
    .select()
    .from(scanCheckpoints)
    .where(
      and(
        eq(scanCheckpoints.scanPhase, PHASE_NAME),
        eq(scanCheckpoints.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (checkpoint.length > 0) {
    const cp = checkpoint[0]!;
    const age = now.getTime() - cp.startedAt.getTime();
    if (age > STALE_THRESHOLD_MS) {
      // Stale checkpoint - discard and start fresh
      const newCount = cp.discardCount + 1;
      await db
        .update(scanCheckpoints)
        .set({
          lastId: "00000000-0000-0000-0000-000000000000",
          startedAt: now,
          discardCount: newCount,
        })
        .where(
          and(
            eq(scanCheckpoints.scanPhase, PHASE_NAME),
            eq(scanCheckpoints.tenantId, tenantId),
          ),
        );
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
    await db.insert(scanCheckpoints).values({
      scanPhase: PHASE_NAME,
      tenantId,
      lastId: "00000000-0000-0000-0000-000000000000",
      startedAt: now,
      discardCount: 0,
    }).onConflictDoNothing();
  }

  const startTime = Date.now();

  // Flow plan cache: avoid re-fetching the same flow's plan per batch
  const flowPlanCache = new Map<string, {
    status: string;
    plan: CompiledStep[] | null;
    exitConditions: unknown[] | null;
  }>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Keyset pagination on active memberships for this tenant
    const whereConditions = [
      eq(flowMemberships.tenantId, tenantId),
      eq(flowMemberships.status, "active"),
    ];
    if (lastId !== null) {
      whereConditions.push(gt(flowMemberships.id, lastId));
    }

    const batch = await db
      .select({
        id: flowMemberships.id,
        contactId: flowMemberships.contactId,
        flowId: flowMemberships.flowId,
        currentStep: flowMemberships.currentStep,
        enteredAt: flowMemberships.enteredAt,
        conditionError: flowMemberships.conditionError,
      })
      .from(flowMemberships)
      .where(and(...whereConditions))
      .orderBy(flowMemberships.id)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const membership of batch) {
      stats.membershipsEvaluated++;

      // Get flow plan (cached)
      let flowInfo = flowPlanCache.get(membership.flowId);
      if (!flowInfo) {
        const flowRow = await db
          .select({
            status: flows.status,
            compiledPlan: flows.compiledPlan,
          })
          .from(flows)
          .where(eq(flows.id, membership.flowId))
          .limit(1);

        if (flowRow.length === 0) {
          // Flow deleted - should not happen with FK, but defensive. Skip.
          flowInfo = { status: "archived", plan: null, exitConditions: null };
        } else {
          const raw = flowRow[0]!;
          const plan = extractSteps(raw.compiledPlan);
          const exitConditions = extractExitConditions(raw.compiledPlan);
          flowInfo = { status: raw.status ?? "draft", plan, exitConditions };
        }
        flowPlanCache.set(membership.flowId, flowInfo);
      }

      // Handle archived flow: exit the membership
      if (flowInfo.status === "archived") {
        await db
          .update(flowMemberships)
          .set({
            status: "exited",
            exitedAt: now,
            exitReason: "flow_archived",
          })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
            ),
          );
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

      const contactRow = await db
        .select({ lifecycleState: contacts.lifecycleState })
        .from(contacts)
        .where(eq(contacts.id, membership.contactId))
        .limit(1);

      if (contactRow.length === 0) {
        // Contact deleted mid-scan. Skip.
        continue;
      }

      const contactState: ContactState = {
        lifecycleState: contactRow[0]!.lifecycleState,
      };

      const eventChecker: EventChecker = {
        async hasEventSince(eventName: string, since: Date): Promise<boolean> {
          const found = await db
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.contactId, membership.contactId),
                eq(events.eventName, eventName),
                gte(events.timestamp, since),
              ),
            )
            .limit(1);
          return found.length > 0;
        },
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
            await db
              .update(flowMemberships)
              .set({ conditionError: conditionErrorMsg })
              .where(eq(flowMemberships.id, membership.id));
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (exitFired) {
          // Clear condition_error if present (the plan is now valid)
          const setClause: Record<string, unknown> = {
            status: "exited",
            exitedAt: now,
            exitReason: "condition_met",
          };
          if (membership.conditionError !== null) {
            setClause.conditionError = null;
          }
          await db
            .update(flowMemberships)
            .set(setClause)
            .where(
              and(
                eq(flowMemberships.id, membership.id),
                eq(flowMemberships.status, "active"),
              ),
            );
          stats.membershipsExitedCondition++;
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
        await db
          .update(flowMemberships)
          .set({
            status: "completed",
            completedAt: now,
            exitReason: "completed",
            ...(membership.conditionError !== null ? { conditionError: null } : {}),
          })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
            ),
          );
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
        const prevMessage = await db
          .select({ createdAt: lifecycleMessages.createdAt })
          .from(lifecycleMessages)
          .where(
            and(
              eq(lifecycleMessages.membershipId, membership.id),
              eq(lifecycleMessages.flowStepOrder, membership.currentStep - 1),
            ),
          )
          .limit(1);

        if (prevMessage.length === 0 || !prevMessage[0]!.createdAt) {
          // No previous message found - the previous step was skipped by condition.
          // Use entered_at as fallback (the delay will have elapsed).
          referenceTime = membership.enteredAt;
        } else {
          referenceTime = prevMessage[0]!.createdAt;
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
          await db
            .update(flowMemberships)
            .set({ conditionError: null })
            .where(eq(flowMemberships.id, membership.id));
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
            await db
              .update(flowMemberships)
              .set({ conditionError: errMsg })
              .where(eq(flowMemberships.id, membership.id));
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (exitResult.outcome === "pass") {
          // Exit condition fired - exit the membership
          await db
            .update(flowMemberships)
            .set({
              status: "exited",
              exitedAt: now,
              exitReason: "condition_met",
              ...(membership.conditionError !== null ? { conditionError: null } : {}),
            })
            .where(
              and(
                eq(flowMemberships.id, membership.id),
                eq(flowMemberships.status, "active"),
              ),
            );
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
            await db
              .update(flowMemberships)
              .set({ conditionError: errMsg })
              .where(eq(flowMemberships.id, membership.id));
          }
          stats.membershipsStuckConditionError++;
          continue;
        }

        if (condResult.outcome === "fail") {
          // Condition is false - skip this step (no message), advance to next
          const totalSteps = steps.length;
          const isLastStep = membership.currentStep >= totalSteps;

          if (isLastStep) {
            await db
              .update(flowMemberships)
              .set({
                status: "completed",
                completedAt: now,
                exitReason: "completed",
                currentStep: membership.currentStep,
                ...(membership.conditionError !== null ? { conditionError: null } : {}),
              })
              .where(
                and(
                  eq(flowMemberships.id, membership.id),
                  eq(flowMemberships.status, "active"),
                  eq(flowMemberships.currentStep, membership.currentStep),
                ),
              );
            stats.membershipsCompleted++;
          } else {
            await db
              .update(flowMemberships)
              .set({
                currentStep: membership.currentStep + 1,
                ...(membership.conditionError !== null ? { conditionError: null } : {}),
              })
              .where(
                and(
                  eq(flowMemberships.id, membership.id),
                  eq(flowMemberships.status, "active"),
                  eq(flowMemberships.currentStep, membership.currentStep),
                ),
              );
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
      const clearError = membership.conditionError !== null ? { conditionError: null } : {};

      // Use INSERT ... ON CONFLICT DO NOTHING for crash-safe idempotency.
      const inserted = await db
        .insert(lifecycleMessages)
        .values({
          tenantId,
          contactId: membership.contactId,
          flowId: membership.flowId,
          membershipId: membership.id,
          flowStepOrder: membership.currentStep,
          status: "pending_generation",
          brainActionType: currentStepDef.action_type,
        })
        .onConflictDoNothing()
        .returning({ id: lifecycleMessages.id });

      if (inserted.length > 0) {
        stats.messagesCreated++;
      }
      // Whether or not we just inserted (vs. conflict = already existed from prior crash),
      // advance the step.

      const totalSteps = steps.length;
      const isLastStep = membership.currentStep >= totalSteps;

      if (isLastStep) {
        // Complete the membership
        const updated = await db
          .update(flowMemberships)
          .set({
            status: "completed",
            completedAt: now,
            exitReason: "completed",
            currentStep: membership.currentStep,
            ...clearError,
          })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
              eq(flowMemberships.currentStep, membership.currentStep),
            ),
          )
          .returning({ id: flowMemberships.id });

        if (updated.length > 0) {
          stats.membershipsCompleted++;
        }
      } else {
        // Advance to next step (CAS on current_step to prevent double-advance)
        const updated = await db
          .update(flowMemberships)
          .set({
            currentStep: membership.currentStep + 1,
            ...clearError,
          })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
              eq(flowMemberships.currentStep, membership.currentStep),
            ),
          )
          .returning({ id: flowMemberships.id });

        if (updated.length > 0) {
          stats.stepsAdvanced++;
        }
      }
    }

    // Update checkpoint after each batch
    lastId = batch[batch.length - 1]!.id;
    await db
      .update(scanCheckpoints)
      .set({ lastId })
      .where(
        and(
          eq(scanCheckpoints.scanPhase, PHASE_NAME),
          eq(scanCheckpoints.tenantId, tenantId),
        ),
      );

    // If batch was smaller than BATCH_SIZE, we've exhausted this tenant
    if (batch.length < BATCH_SIZE) break;
  }

  // Full pass completed - delete the checkpoint row (start fresh next run)
  await db
    .delete(scanCheckpoints)
    .where(
      and(
        eq(scanCheckpoints.scanPhase, PHASE_NAME),
        eq(scanCheckpoints.tenantId, tenantId),
      ),
    );

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
