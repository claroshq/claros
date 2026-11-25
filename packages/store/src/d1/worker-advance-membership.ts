/**
 * SQLite / Cloudflare D1 implementation of the queries used by packages/worker/src/advance-membership.ts
 * (a direct port of ../pg/worker-advance-membership.ts: plain selects and CAS updates).
 */
import { eq, and, gte } from "drizzle-orm";
import {
  contacts,
  events,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerAdvanceMembershipQueries } from "../areas/worker-advance-membership.js";

export function d1WorkerAdvanceMembership(db: D1Db): WorkerAdvanceMembershipQueries {
  return {
    async getMembership({ tenantId, membershipId }) {
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
      return membershipRows[0] ?? null;
    },

    async getFlowPlan(flowId) {
      const flowRow = await db
        .select({
          status: flows.status,
          compiledPlan: flows.compiledPlan,
        })
        .from(flows)
        .where(eq(flows.id, flowId))
        .limit(1);
      return flowRow[0] ?? null;
    },

    async getContactLifecycleState(contactId) {
      const contactRow = await db
        .select({ lifecycleState: contacts.lifecycleState })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      return contactRow[0]?.lifecycleState ?? null;
    },

    async hasEventSince({ contactId, eventName, since }) {
      const found = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.contactId, contactId),
            eq(events.eventName, eventName),
            gte(events.timestamp, since),
          ),
        )
        .limit(1);
      return found.length > 0;
    },

    async setConditionError({ membershipId, conditionError }) {
      await db
        .update(flowMemberships)
        .set({ conditionError })
        .where(eq(flowMemberships.id, membershipId));
    },

    async exitMembership({ membershipId, now, exitReason, clearConditionError }) {
      await db
        .update(flowMemberships)
        .set({
          status: "exited",
          exitedAt: now,
          exitReason,
          ...(clearConditionError ? { conditionError: null } : {}),
        })
        .where(
          and(
            eq(flowMemberships.id, membershipId),
            eq(flowMemberships.status, "active"),
          ),
        );
    },

    async completeMembership({ membershipId, now, clearConditionError }) {
      await db
        .update(flowMemberships)
        .set({
          status: "completed",
          completedAt: now,
          exitReason: "completed",
          ...(clearConditionError ? { conditionError: null } : {}),
        })
        .where(
          and(
            eq(flowMemberships.id, membershipId),
            eq(flowMemberships.status, "active"),
          ),
        );
    },

    async completeMembershipAtStep({ membershipId, step, now, clearConditionError }) {
      const updated = await db
        .update(flowMemberships)
        .set({
          status: "completed",
          completedAt: now,
          exitReason: "completed",
          currentStep: step,
          ...(clearConditionError ? { conditionError: null } : {}),
        })
        .where(
          and(
            eq(flowMemberships.id, membershipId),
            eq(flowMemberships.status, "active"),
            eq(flowMemberships.currentStep, step),
          ),
        )
        .returning({ id: flowMemberships.id });
      return updated.length > 0;
    },

    async advanceMembershipStep({ membershipId, fromStep, clearConditionError }) {
      // Advance to next step (CAS on current_step to prevent double-advance)
      const updated = await db
        .update(flowMemberships)
        .set({
          currentStep: fromStep + 1,
          ...(clearConditionError ? { conditionError: null } : {}),
        })
        .where(
          and(
            eq(flowMemberships.id, membershipId),
            eq(flowMemberships.status, "active"),
            eq(flowMemberships.currentStep, fromStep),
          ),
        )
        .returning({ id: flowMemberships.id });
      return updated.length > 0;
    },

    async getStepMessageCreatedAt({ membershipId, stepOrder }) {
      const prevMessage = await db
        .select({ createdAt: lifecycleMessages.createdAt })
        .from(lifecycleMessages)
        .where(
          and(
            eq(lifecycleMessages.membershipId, membershipId),
            eq(lifecycleMessages.flowStepOrder, stepOrder),
          ),
        )
        .limit(1);
      return prevMessage[0]?.createdAt ?? null;
    },

    async createStepMessage({ tenantId, contactId, flowId, membershipId, stepOrder, actionType }) {
      // Use INSERT ... ON CONFLICT DO NOTHING for crash-safe idempotency.
      const inserted = await db
        .insert(lifecycleMessages)
        .values({
          tenantId,
          contactId,
          flowId,
          membershipId,
          flowStepOrder: stepOrder,
          status: "pending_generation",
          brainActionType: actionType,
        })
        .onConflictDoNothing()
        .returning({ id: lifecycleMessages.id });
      return inserted[0]?.id ?? null;
    },
  };
}
