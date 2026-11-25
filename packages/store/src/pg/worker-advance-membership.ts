/**
 * Postgres implementation of the queries used by packages/worker/src/advance-membership.ts.
 */
import { eq, and, gte, sql } from "drizzle-orm";
import {
  contacts,
  events,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";
import { pgContactConditions } from "./contact-conditions.js";
import type { PgDb } from "./db.js";
import { pgWriteOutbox } from "./outbox.js";
import type { WorkerAdvanceMembershipQueries } from "../areas/worker-advance-membership.js";

export function pgWorkerAdvanceMembership(db: PgDb): WorkerAdvanceMembershipQueries {
  return {
    ...pgContactConditions(db),
    async getMembership({ tenantId, membershipId }) {
      const membershipRows = await db
        .select({
          id: flowMemberships.id,
          contactId: flowMemberships.contactId,
          flowId: flowMemberships.flowId,
          currentStep: flowMemberships.currentStep,
          enteredAt: flowMemberships.enteredAt,
          conditionError: flowMemberships.conditionError,
          anchorAt: flowMemberships.anchorAt,
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

    async exitMembership({ membershipId, now, exitReason, clearConditionError, events }) {
      const update = db
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
      if (!events || events.outbox.length === 0) {
        await update;
        return;
      }
      await db.transaction(async (tx) => {
        const exited = await (tx as unknown as PgDb)
          .update(flowMemberships)
          .set({ status: "exited", exitedAt: now, exitReason, ...(clearConditionError ? { conditionError: null } : {}) })
          .where(and(eq(flowMemberships.id, membershipId), eq(flowMemberships.status, "active")))
          .returning({ id: flowMemberships.id });
        if (exited.length > 0) await pgWriteOutbox(tx as unknown as PgDb, events.tenantId, events.outbox, now);
      });
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

    async createStepMessage({ tenantId, contactId, flowId, membershipId, stepOrder, actionType, scheduledSendAt = null, expiresAt = null }) {
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
          scheduledSendAt,
          expiresAt,
          // The flow's topic at creation time (G8a).
          topicId: sql`(SELECT topic_id FROM flows WHERE id = ${flowId} AND tenant_id = ${tenantId})`,
        })
        .onConflictDoNothing()
        .returning({ id: lifecycleMessages.id });
      return inserted[0]?.id ?? null;
    },
  };
}
