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
import { eq, and, sql, gte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  contacts,
  events,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";
import {
  parseDelay,
  delayToMs,
  compiledPlanSchema,
  type CompiledStep,
  type AdvanceMembershipJobData,
} from "@claros/core";
import {
  evaluateStepCondition,
  evaluatePlanExitCondition,
  formatConditionError,
  type ContactState,
  type EventChecker,
} from "./condition-evaluator.js";

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
  const membershipRows = await db
    .select({
      id: flowMemberships.id,
      contactId: flowMemberships.contactId,
      flowId: flowMemberships.flowId,
      currentStep: flowMemberships.currentStep,
      enteredAt: flowMemberships.enteredAt,
      conditionError: flowMemberships.conditionError,
      status: flowMemberships.status,
    })
    .from(flowMemberships)
    .where(
      and(
        eq(flowMemberships.id, membershipId),
        eq(flowMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (membershipRows.length === 0) {
    result.skipped = true;
    return result;
  }

  const membership = membershipRows[0]!;

  // Only process active memberships
  if (membership.status !== "active") {
    result.skipped = true;
    return result;
  }

  // Load flow
  const flowRows = await db
    .select({
      status: flows.status,
      compiledPlan: flows.compiledPlan,
    })
    .from(flows)
    .where(eq(flows.id, membership.flowId))
    .limit(1);

  if (flowRows.length === 0) {
    result.skipped = true;
    return result;
  }

  const flowRow = flowRows[0]!;

  // Handle archived flow: exit the membership
  if (flowRow.status === "archived") {
    await db
      .update(flowMemberships)
      .set({ status: "exited", exitedAt: now, exitReason: "flow_archived" })
      .where(
        and(
          eq(flowMemberships.id, membership.id),
          eq(flowMemberships.status, "active"),
        ),
      );
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
  const contactRow = await db
    .select({ lifecycleState: contacts.lifecycleState })
    .from(contacts)
    .where(eq(contacts.id, membership.contactId))
    .limit(1);

  if (contactRow.length === 0) {
    result.skipped = true;
    return result;
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
        await db
          .update(flowMemberships)
          .set({ conditionError: errMsg })
          .where(eq(flowMemberships.id, membership.id));
      }
      result.skipped = true;
      return result;
    }

    if (ecResult.outcome === "pass") {
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
      result.exited = true;
      return result;
    }
  }

  // Find current step definition
  const currentStepDef = steps.find((s) => s.order === membership.currentStep);
  if (!currentStepDef) {
    // Plan was recompiled with fewer steps - complete the membership
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
    result.completed = true;
    return result;
  }

  // Compute delay reference time
  let referenceTime: Date;
  if (membership.currentStep === 1) {
    referenceTime = membership.enteredAt;
  } else {
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

    referenceTime = prevMessage.length > 0 && prevMessage[0]!.createdAt
      ? prevMessage[0]!.createdAt
      : membership.enteredAt;
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
      await db
        .update(flowMemberships)
        .set({ conditionError: null })
        .where(eq(flowMemberships.id, membership.id));
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
        await db
          .update(flowMemberships)
          .set({ conditionError: errMsg })
          .where(eq(flowMemberships.id, membership.id));
      }
      result.skipped = true;
      return result;
    }

    if (exitResult.outcome === "pass") {
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
        await db
          .update(flowMemberships)
          .set({ conditionError: errMsg })
          .where(eq(flowMemberships.id, membership.id));
      }
      result.skipped = true;
      return result;
    }

    if (condResult.outcome === "fail") {
      // Condition is false - skip this step, advance to next
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
        result.completed = true;
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
        result.advanced = true;
      }
      return result;
    }
  }

  // All conditions passed: create message and advance step
  const clearError = membership.conditionError !== null ? { conditionError: null } : {};

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
    result.messageCreated = true;
    result.messageId = inserted[0]!.id;
  }

  // Advance step (or complete)
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
        ...clearError,
      })
      .where(
        and(
          eq(flowMemberships.id, membership.id),
          eq(flowMemberships.status, "active"),
          eq(flowMemberships.currentStep, membership.currentStep),
        ),
      );
    result.completed = true;
  } else {
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
      result.advanced = true;
    }
  }

  return result;
}
