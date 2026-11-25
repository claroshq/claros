/**
 * Date-property triggers and schedules (G3), and step expiry.
 *
 * Scan phase 2c (phaseDateEnrollment), per product and active date flow:
 *   1. Memberships whose anchor no longer equals the contact's date trait
 *      (the date moved or was removed) are exited with reason
 *      'date_changed'; their unsent messages are cancelled.
 *   2. Contacts from contact_dates whose schedule has a slot due now (and not
 *      older than DATE_SLOT_GRACE_MS) and who have no membership of the flow
 *      for that anchor value are enrolled through the standard enrollment
 *      sequence (suppression, class concurrency), keyed by the anchor: the
 *      unique index on (tenant, flow, contact, anchor) enrolls a contact once
 *      per anchor value. Trigger `where` conditions must hold.
 *
 * Step advancement (scan phase 3 and the targeted advance-membership job)
 * calls stepDateMembership() for memberships with an anchor:
 *   - the stale-anchor check above, for both trigger types;
 *   - date_schedule: the membership's current_step is the slot number; slot
 *     k is due at its schedule time, uses the plan step with the greatest
 *     order <= k, re-checks step and trigger conditions at each send, and
 *     skips slots older than the grace window.
 *   - date_property: after the stale check, the normal delay-based step
 *     logic runs (the membership is created when the date is due).
 *
 * cancelExpiredMessages(): unsent messages past their expires_at (step
 * expires_after) are cancelled with reason 'expired'.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  parseDateTrigger,
  dateTriggerProperty,
  dateTimezone,
  firstOpenSlot,
  anchorWindow,
  slotDue,
  totalSlots,
  stepForSlot,
  durationMs,
  resolveThrottleConfig,
  evaluateAudienceCondition,
  cachedConditionContext,
  toFlowClass,
  DATE_SLOT_GRACE_MS,
  type CompiledStep,
  type DateTrigger,
  type EnrollableFlow,
} from "@claros/core";
import { enrollContactInFlows } from "./enroll.js";
import { passesTriggerWhere } from "./audience.js";
import { evaluateStepCondition, formatConditionError, type ContactState, type EventChecker } from "./condition-evaluator.js";

type Db = NodePgDatabase<Record<string, never>>;

/** Most enrollments per date flow per scan run (the rest enroll on later runs). */
export const DATE_ENROLLMENT_CAP = 200;
/** Most contact_dates rows read per date flow per scan run. */
const DATE_SCAN_ROW_CAP = 5000;
const PAGE = 200;

export interface PhaseDateEnrollmentResult {
  flowsEvaluated: number;
  staleExited: number;
  enrollmentsAttempted: number;
  enrollmentsSucceeded: number;
  expiredCancelled: number;
}

/** Product timezone for send_at_local (throttle.tenant_timezone). */
export function productTimezone(settings: Record<string, unknown> | null | undefined): string | undefined {
  return resolveThrottleConfig(settings ?? null).tenant_timezone;
}

/** The plan's trigger as a date trigger, or null. */
export function planDateTrigger(compiledPlan: unknown): DateTrigger | null {
  if (!compiledPlan || typeof compiledPlan !== "object") return null;
  const trigger = (compiledPlan as { trigger?: { type?: unknown; condition?: unknown } }).trigger;
  if (!trigger) return null;
  return parseDateTrigger(trigger.type, trigger.condition);
}

/** Expiry of a message created now for a step with expires_after, or null. */
export function stepExpiresAt(step: { expires_after?: string } | undefined, now: Date): Date | null {
  if (!step?.expires_after) return null;
  const ms = durationMs(step.expires_after);
  return ms === null ? null : new Date(now.getTime() + ms);
}

export async function phaseDateEnrollment(db: Db, now: Date, tenantIds?: string[]): Promise<PhaseDateEnrollmentResult> {
  const store = storeFor(db).workerDates;
  const stats: PhaseDateEnrollmentResult = {
    flowsEvaluated: 0,
    staleExited: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    expiredCancelled: 0,
  };

  for (const tenant of await store.listTenants(tenantIds)) {
    const flows = await store.listActiveDateFlows(tenant.id);
    if (flows.length === 0) continue;
    const tz = productTimezone(tenant.settings as Record<string, unknown> | null);

    for (const flow of flows) {
      const trigger = parseDateTrigger(flow.triggerType, flow.triggerConfig);
      if (!trigger) continue;
      stats.flowsEvaluated++;
      const property = dateTriggerProperty(trigger);

      // 1. Moved or removed dates: exit the stale enrollment.
      for (const stale of await store.listStaleMemberships({ tenantId: tenant.id, flowId: flow.id, property, limit: 500 })) {
        const exited = await store.exitStaleMembership({
          tenantId: tenant.id,
          membershipId: stale.membershipId,
          contactId: stale.contactId,
          flowId: flow.id,
          reason: "date_changed",
          now,
        });
        if (exited) stats.staleExited++;
      }

      // 2. Enroll contacts with a slot due now.
      const enrollable: EnrollableFlow = {
        id: flow.id,
        tenantId: flow.tenantId,
        priority: flow.priority ?? 0,
        triggerType: trigger.type,
        triggerConfig: flow.triggerConfig,
        flowClass: toFlowClass(flow.flowClass),
        reentryPolicy: (flow.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
        reentryCooldownDays: flow.reentryCooldownDays ?? 30,
      };
      const { from, to } = anchorWindow(trigger, now);
      let after: string | null = null;
      let read = 0;
      let enrolled = 0;
      while (read < DATE_SCAN_ROW_CAP && enrolled < DATE_ENROLLMENT_CAP) {
        const page = await store.listDueCandidates({ tenantId: tenant.id, flowId: flow.id, property, from, to, afterContactId: after, limit: PAGE });
        if (page.length === 0) break;
        read += page.length;
        after = page[page.length - 1]!.contactId;
        for (const cand of page) {
          const open = firstOpenSlot(trigger, cand.value, now, dateTimezone(cand.timezone, tz));
          if (!open || open.due.getTime() > now.getTime()) continue;
          if (trigger.where !== undefined && !(await passesTriggerWhere(store, flow.triggerConfig, tenant.id, cand.contactId, now))) continue;
          stats.enrollmentsAttempted++;
          const [result] = await enrollContactInFlows(db, cand.contactId, tenant.id, [enrollable], now, cand.value);
          if (result?.enrolled) {
            stats.enrollmentsSucceeded++;
            enrolled++;
            if (enrolled >= DATE_ENROLLMENT_CAP) break;
          }
        }
        if (page.length < PAGE) break;
      }
    }
  }

  stats.expiredCancelled = await cancelExpiredMessages(db, now);
  return stats;
}

/** Cancel unsent messages past their expires_at (reason 'expired'). Returns how many. */
export async function cancelExpiredMessages(db: Db, now: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const rows = await storeFor(db).workerDates.cancelExpiredMessages({ now, limit: 500 });
    total += rows.length;
    if (rows.length < 500) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Step advancement for memberships with an anchor
// ---------------------------------------------------------------------------

/** The step-advancement store methods a date step needs (both worker areas have them). */
export interface DateStepOps {
  createStepMessage(input: {
    tenantId: string;
    contactId: string;
    flowId: string;
    membershipId: string;
    stepOrder: number;
    actionType: string;
    scheduledSendAt?: Date | null;
    expiresAt?: Date | null;
  }): Promise<string | null>;
  advanceMembershipStep(input: { membershipId: string; fromStep: number; clearConditionError: boolean }): Promise<boolean>;
  completeMembershipAtStep(input: { membershipId: string; step: number; now: Date; clearConditionError: boolean }): Promise<boolean>;
  exitMembership(input: {
    membershipId: string;
    now: Date;
    exitReason: string;
    clearConditionError: boolean;
    events?: { tenantId: string; outbox: Array<{ event: string; payload: Record<string, unknown> }> };
  }): Promise<void>;
  setConditionError(input: { membershipId: string; conditionError: string | null }): Promise<void>;
}

export interface DateMembership {
  id: string;
  contactId: string;
  flowId: string;
  currentStep: number;
  anchorAt: Date | null;
  conditionError: string | null;
}

export type DateStepOutcome =
  | { kind: "not_date" }
  | { kind: "stale_exited" }
  | { kind: "waiting" }
  | { kind: "exited" }
  | { kind: "skipped"; completed: boolean }
  | { kind: "completed" }
  | { kind: "condition_error" }
  | { kind: "message"; messageId: string | null; completed: boolean; advanced: boolean };

/**
 * Process a membership of a date-triggered flow. Returns not_date when the
 * normal step logic should run (no anchor, not a date flow, or a
 * date_property flow whose anchor is current).
 */
export async function stepDateMembership(
  db: Db,
  input: {
    tenantId: string;
    membership: DateMembership;
    compiledPlan: unknown;
    steps: CompiledStep[];
    now: Date;
    contactState: ContactState;
    eventChecker: EventChecker;
    ops: DateStepOps;
  },
): Promise<DateStepOutcome> {
  const { tenantId, membership, steps, now, contactState, eventChecker, ops } = input;
  const trigger = planDateTrigger(input.compiledPlan);
  if (!trigger || !membership.anchorAt) return { kind: "not_date" };
  const store = storeFor(db).workerDates;

  const current = await store.getContactDate({ tenantId, contactId: membership.contactId, property: dateTriggerProperty(trigger) });
  if (!current || current.getTime() !== membership.anchorAt.getTime()) {
    await store.exitStaleMembership({
      tenantId,
      membershipId: membership.id,
      contactId: membership.contactId,
      flowId: membership.flowId,
      reason: "date_changed",
      now,
    });
    return { kind: "stale_exited" };
  }
  if (trigger.type === "date_property") return { kind: "not_date" };

  const clear = membership.conditionError !== null;
  const total = totalSlots(trigger);
  let k = membership.currentStep;
  if (k > total) {
    await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
    return { kind: "completed" };
  }

  const traits = eventChecker.contact ? await eventChecker.contact.traits() : {};
  const settings = await store.getTenantSettings(tenantId);
  const tz = dateTimezone(traits.timezone, productTimezone(settings));
  let due = slotDue(trigger, membership.anchorAt, k, tz);
  if (!due) {
    await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
    return { kind: "completed" };
  }
  if (due.getTime() < now.getTime() - DATE_SLOT_GRACE_MS) {
    // Missed slots (worker downtime, late enrollment): move to the first open one.
    const open = firstOpenSlot(trigger, membership.anchorAt, now, tz, k + 1);
    if (!open) {
      await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
      return { kind: "completed" };
    }
    if (!(await store.jumpMembershipStep({ membershipId: membership.id, fromStep: k, toStep: open.slot }))) return { kind: "waiting" };
    k = open.slot;
    due = open.due;
  }
  if (due.getTime() > now.getTime()) return { kind: "waiting" };

  const step = stepForSlot(steps, k);
  if (!step) {
    await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
    return { kind: "completed" };
  }

  if (step.exit_condition !== undefined) {
    const r = await evaluateStepCondition(step.exit_condition, contactState, eventChecker, due);
    if (r.outcome === "unknown_shape") {
      await ops.setConditionError({ membershipId: membership.id, conditionError: formatConditionError({ type: "step_exit_condition", stepOrder: k }, r.message) });
      return { kind: "condition_error" };
    }
    if (r.outcome === "pass") {
      await ops.exitMembership({
        membershipId: membership.id,
        now,
        exitReason: "condition_met",
        clearConditionError: clear,
        events: { tenantId, outbox: [{ event: "flow.exited", payload: { membership_id: membership.id, contact_id: membership.contactId, flow_id: membership.flowId, reason: "condition_met" } }] },
      });
      return { kind: "exited" };
    }
  }

  // Conditions re-checked at each send: the step's condition and the trigger's `where`.
  let pass = true;
  if (step.condition !== undefined) {
    const r = await evaluateStepCondition(step.condition, contactState, eventChecker, due);
    if (r.outcome === "unknown_shape") {
      await ops.setConditionError({ membershipId: membership.id, conditionError: formatConditionError({ type: "step_condition", stepOrder: k }, r.message) });
      return { kind: "condition_error" };
    }
    pass = r.outcome === "pass";
  }
  if (pass && trigger.where !== undefined && eventChecker.contact) {
    pass = (await evaluateAudienceCondition(trigger.where, eventChecker.contact)) === true;
  }
  const last = k >= total;
  if (!pass) {
    if (last) await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
    else await ops.advanceMembershipStep({ membershipId: membership.id, fromStep: k, clearConditionError: clear });
    return { kind: "skipped", completed: last };
  }

  const messageId = await ops.createStepMessage({
    tenantId,
    contactId: membership.contactId,
    flowId: membership.flowId,
    membershipId: membership.id,
    stepOrder: k,
    actionType: step.action_type,
    expiresAt: stepExpiresAt(step, now),
  });
  if (last) {
    const completed = await ops.completeMembershipAtStep({ membershipId: membership.id, step: k, now, clearConditionError: clear });
    return { kind: "message", messageId, completed, advanced: false };
  }
  const advanced = await ops.advanceMembershipStep({ membershipId: membership.id, fromStep: k, clearConditionError: clear });
  return { kind: "message", messageId, completed: false, advanced };
}

/**
 * The `date_unchanged` lookup for a membership: compares its anchor with the
 * contact's indexed date trait. Undefined (condition passes) when the
 * membership has no anchor or the flow is not date-triggered.
 */
export function dateUnchangedCheck(
  db: Db,
  tenantId: string,
  membership: { contactId: string; anchorAt: Date | null },
  compiledPlan: unknown,
): (() => Promise<boolean>) | undefined {
  const trigger = planDateTrigger(compiledPlan);
  const anchor = membership.anchorAt;
  if (!trigger || !anchor) return undefined;
  return async () => {
    const v = await storeFor(db).workerDates.getContactDate({ tenantId, contactId: membership.contactId, property: dateTriggerProperty(trigger) });
    return v !== null && v.getTime() === anchor.getTime();
  };
}
