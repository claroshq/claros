/**
 * Send-time exit check.
 *
 * A flow's exit conditions are evaluated by the step scan, between steps.
 * A message already drafted (waiting for approval, the send window or the
 * throttle) is not covered by that: in a one-step flow the membership is
 * complete as soon as the draft exists, and in a longer flow the exit is
 * checked only when the next step comes up. So a cancel-save note went out
 * after the user had reactivated, and a dunning mail after the payment had
 * recovered. The drain therefore checks the plan's exits again right before
 * sending, against the same reference time (the membership's entered_at):
 * if one is met, the message is cancelled with status_reason 'exit_met'.
 *
 * An exit the evaluator cannot read (unknown shape) does not block a send:
 * the step scan already records it as a condition_error on the membership.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { cachedConditionContext } from "@claros/core";
import { evaluatePlanExitCondition, type EventChecker } from "./condition-evaluator.js";

type Db = NodePgDatabase<Record<string, never>>;

export function planExitConditions(compiledPlan: unknown): unknown[] {
  if (!compiledPlan || typeof compiledPlan !== "object") return [];
  const exits = (compiledPlan as Record<string, unknown>).exit_conditions;
  return Array.isArray(exits) ? exits : [];
}

/** True when one of the flow's exit conditions is met for this message's contact. */
export async function exitMetAtSend(
  db: Db,
  input: { tenantId: string; messageId: string; contactId: string; compiledPlan: unknown; now: Date },
): Promise<boolean> {
  const exits = planExitConditions(input.compiledPlan);
  if (exits.length === 0) return false;
  const store = storeFor(db);
  const ref = await store.workerDrain.getExitCheckInput({ tenantId: input.tenantId, messageId: input.messageId });
  if (!ref) return false;
  const checker: EventChecker = {
    hasEventSince: (eventName, since) => store.workerDrain.hasEventSince({ contactId: input.contactId, eventName, since }),
    contact: cachedConditionContext({
      now: input.now,
      traits: async () => (await store.workerScanStepAdvancement.getContactTraits({ tenantId: input.tenantId, contactId: input.contactId })) ?? {},
      countSends: (f) => store.workerScanStepAdvancement.countSends({ tenantId: input.tenantId, contactId: input.contactId, ...f }),
      lifecycleState: async () => ref.lifecycleState,
    }),
  };
  for (const exit of exits) {
    const r = await evaluatePlanExitCondition(exit, { lifecycleState: ref.lifecycleState ?? "" }, checker, ref.enteredAt);
    if (r.outcome === "pass") return true;
  }
  return false;
}
