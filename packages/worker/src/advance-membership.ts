/**
 * Targeted step advancement: process a single membership's current step.
 *
 * Enqueued immediately after enrollment succeeds (trigger-check or scan-enrollment).
 * Eliminates the 15-min scan wait for freshly enrolled contacts. The periodic
 * scan remains as a safety net.
 *
 * Processing is identical to the per-membership logic in scan-step-advancement.ts
 * but operates on a single membership by ID rather than paginating all active
 * memberships.
 *
 * Safety:
 *   - CAS on current_step prevents double-advance if both targeted and cron fire.
 *   - ON CONFLICT DO NOTHING on message insert prevents duplicates.
 *   - If the membership is not active (already completed/exited), returns immediately.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  parseDelay,
  delayToMs,
  compiledPlanSchema,
  type CompiledStep,
  type AdvanceMembershipJobData,
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
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface AdvanceMembershipResult {
  /** Whether a message was created for this step. */
  messageCreated: boolean;
  /** Whether the membership was advanced to the next step. */
  advanced: boolean;
  /** Whether the membership completed (no more steps). */
  completed: boolean;
  /** Whether the membership was exited by a condition. */
  exited: boolean;
  /** Whether the step was skipped (delay not elapsed or flow paused). */
  skipped: boolean;
  /** The ID of the created message, if any. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single claros.advance-membership job.
 *
 * Processes the current step of the specified membership. If the step's delay
 * has elapsed (for step 1 with delay "0h" this is always true at enrollment
 * time), creates a pending_generation message and advances the step.
 *
 * Returns the result for observability and chaining (the caller can enqueue
 * a process-message job if a message was created).
 */
export async function handleAdvanceMembership(
  data: AdvanceMembershipJobData,
  db: Db,
): Promise<AdvanceMembershipResult> {
  const { tenant_id: tenantId, membership_id: membershipId } = data;
  const now = new Date();

  const result: AdvanceMembershipResult = {
    messageCreated: false,
    advanced: false,
    completed: false,
    exited: false,
    skipped: false,
  };

  // Load the membership
  const membership = await storeFor(db).workerAdvanceMembership.getMembership({ tenantId, membershipId });

  if (membership === null) {
    result.skipped = true;
    return result;
  }

  // Only process active memberships
  if (membership.status !== "active") {
    result.skipped = true;
    return result;
  }

  // Load flow
  const flowRow = await storeFor(db).workerAdvanceMembership.getFlowPlan(membership.flowId);

  if (flowRow === null) {
    result.skipped = true;
    return result;
  }

  // Handle archived flow: exit the membership
  if (flowRow.status === "archived") {
    await storeFor(db).workerAdvanceMembership.exitMembership({
      membershipId: membership.id,
      now,
      exitReason: "flow_archived",
      clearConditionError: false,
      events: exitEvent(tenantId, membership, "flow_archived"),
    });
    result.exited = true;
    return result;
  }

  // Handle paused flow or null plan: skip
  if (flowRow.status === "paused" || flowRow.compiledPlan === null) {
    result.skipped = true;
    return result;
  }

  // Parse compiled plan
  const parsed = compiledPlanSchema.safeParse(flowRow.compiledPlan);
  if (!parsed.success) {
    result.skipped = true;
    return result;
  }

  const steps: CompiledStep[] = parsed.data.steps;
  const exitConditions = parsed.data.exit_conditions ?? [];

  // Build contact state
  const lifecycleState = await storeFor(db).workerAdvanceMembership.getContactLifecycleState(membership.contactId);

  if (lifecycleState === null) {
    result.skipped = true;
    return result;
  }

  const contactState: ContactState = {
    lifecycleState,
  };

  const eventChecker: EventChecker = {
    async hasEventSince(eventName: string, since: Date): Promise<boolean> {
      return storeFor(db).workerAdvanceMembership.hasEventSince({
        contactId: membership.contactId,
        eventName,
        since,
      });
    },
    contact: cachedConditionContext({
      now,
      traits: async () =>
        (await storeFor(db).workerAdvanceMembership.getContactTraits({ tenantId, contactId: membership.contactId })) ?? {},
      countSends: (f) =>
        storeFor(db).workerAdvanceMembership.countSends({ tenantId, contactId: membership.contactId, ...f }),
      lifecycleState: () => storeFor(db).workerAdvanceMembership.lookupLifecycleState({ tenantId, contactId: membership.contactId }),
    }),
    dateUnchanged: dateUnchangedCheck(db, tenantId, membership, flowRow.compiledPlan),
  };

  // Evaluate plan-level exit conditions
  for (const ec of exitConditions) {
    const ecResult = await evaluatePlanExitCondition(
      ec,
      contactState,
      eventChecker,
      membership.enteredAt,
    );

    if (ecResult.outcome === "unknown_shape") {
      const errMsg = formatConditionError({ type: "plan_exit" }, ecResult.message);
      if (membership.conditionError !== errMsg) {
        await storeFor(db).workerAdvanceMembership.setConditionError({
          membershipId: membership.id,
          conditionError: errMsg,
        });
      }
      result.skipped = true;
      return result;
    }

    if (ecResult.outcome === "pass") {
      await storeFor(db).workerAdvanceMembership.exitMembership({
        membershipId: membership.id,
        now,
        exitReason: "condition_met",
        clearConditionError: membership.conditionError !== null,
        events: exitEvent(tenantId, membership, "condition_met"),
      });
      result.exited = true;
      return result;
    }
  }

  // Date triggers (G3): stale anchors exit; schedules advance by slot.
  if (membership.anchorAt) {
    const dated = await stepDateMembership(db, {
      tenantId,
      membership,
      compiledPlan: flowRow.compiledPlan,
      steps,
      now,
      contactState,
      eventChecker,
      ops: storeFor(db).workerAdvanceMembership,
    });
    if (dated.kind !== "not_date") {
      if (dated.kind === "stale_exited" || dated.kind === "exited") result.exited = true;
      else if (dated.kind === "completed") result.completed = true;
      else if (dated.kind === "skipped") {
        if (dated.completed) result.completed = true;
        else result.advanced = true;
      } else if (dated.kind === "message") {
        if (dated.messageId !== null) {
          result.messageCreated = true;
          result.messageId = dated.messageId;
        }
        result.completed = dated.completed;
        result.advanced = dated.advanced;
      } else result.skipped = true;
      return result;
    }
  }

  // Find current step definition
  const currentStepDef = steps.find((s) => s.order === membership.currentStep);
  if (!currentStepDef) {
    // Plan was recompiled with fewer steps - complete the membership
    await storeFor(db).workerAdvanceMembership.completeMembership({
      membershipId: membership.id,
      now,
      clearConditionError: membership.conditionError !== null,
    });
    result.completed = true;
    return result;
  }

  // Compute delay reference time
  let referenceTime: Date;
  if (membership.currentStep === 1) {
    referenceTime = membership.enteredAt;
  } else {
    const prevCreatedAt = await storeFor(db).workerAdvanceMembership.getStepMessageCreatedAt({
      membershipId: membership.id,
      stepOrder: membership.currentStep - 1,
    });

    referenceTime = prevCreatedAt ?? membership.enteredAt;
  }

  // Parse delay and check if elapsed
  const delayParsed = parseDelay(currentStepDef.delay);
  if (delayParsed === null) {
    result.skipped = true;
    return result;
  }

  const delayMs = delayToMs(delayParsed);
  const elapsed = now.getTime() - referenceTime.getTime();
  if (elapsed < delayMs) {
    // Delay not yet elapsed - clear condition_error if set
    if (membership.conditionError !== null) {
      await storeFor(db).workerAdvanceMembership.setConditionError({
        membershipId: membership.id,
        conditionError: null,
      });
    }
    result.skipped = true;
    return result;
  }

  // Evaluate step-level exit condition
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
        await storeFor(db).workerAdvanceMembership.setConditionError({
          membershipId: membership.id,
          conditionError: errMsg,
        });
      }
      result.skipped = true;
      return result;
    }

    if (exitResult.outcome === "pass") {
      await storeFor(db).workerAdvanceMembership.exitMembership({
        membershipId: membership.id,
        now,
        exitReason: "condition_met",
        clearConditionError: membership.conditionError !== null,
        events: exitEvent(tenantId, membership, "condition_met"),
      });
      result.exited = true;
      return result;
    }
  }

  // Evaluate step-level condition (proceed-if gate)
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
        await storeFor(db).workerAdvanceMembership.setConditionError({
          membershipId: membership.id,
          conditionError: errMsg,
        });
      }
      result.skipped = true;
      return result;
    }

    if (condResult.outcome === "fail") {
      // Condition is false - skip this step, advance to next
      const totalSteps = steps.length;
      const isLastStep = membership.currentStep >= totalSteps;

      if (isLastStep) {
        await storeFor(db).workerAdvanceMembership.completeMembershipAtStep({
          membershipId: membership.id,
          step: membership.currentStep,
          now,
          clearConditionError: membership.conditionError !== null,
        });
        result.completed = true;
      } else {
        await storeFor(db).workerAdvanceMembership.advanceMembershipStep({
          membershipId: membership.id,
          fromStep: membership.currentStep,
          clearConditionError: membership.conditionError !== null,
        });
        result.advanced = true;
      }
      return result;
    }
  }

  // All conditions passed: create message and advance step
  const insertedId = await storeFor(db).workerAdvanceMembership.createStepMessage({
    tenantId,
    contactId: membership.contactId,
    flowId: membership.flowId,
    membershipId: membership.id,
    stepOrder: membership.currentStep,
    actionType: currentStepDef.action_type,
    expiresAt: stepExpiresAt(currentStepDef, now),
  });

  if (insertedId !== null) {
    result.messageCreated = true;
    result.messageId = insertedId;
  }

  // Advance step (or complete)
  const totalSteps = steps.length;
  const isLastStep = membership.currentStep >= totalSteps;

  if (isLastStep) {
    await storeFor(db).workerAdvanceMembership.completeMembershipAtStep({
      membershipId: membership.id,
      step: membership.currentStep,
      now,
      clearConditionError: membership.conditionError !== null,
    });
    result.completed = true;
  } else {
    const advanced = await storeFor(db).workerAdvanceMembership.advanceMembershipStep({
      membershipId: membership.id,
      fromStep: membership.currentStep,
      clearConditionError: membership.conditionError !== null,
    });

    if (advanced) {
      result.advanced = true;
    }
  }

  return result;
}

/** Outbox entry (G5) for a membership exit. */
function exitEvent(tenantId: string, membership: { id: string; contactId: string; flowId: string }, reason: string) {
  return {
    tenantId,
    outbox: [{ event: "flow.exited", payload: { membership_id: membership.id, contact_id: membership.contactId, flow_id: membership.flowId, reason } }],
  };
}
