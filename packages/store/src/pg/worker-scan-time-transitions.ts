/**
 * Postgres implementation of the queries used by packages/worker/src/scan-time-transitions.ts.
 */
import { eq, and, inArray, gt } from "drizzle-orm";
import { contacts, tenants, lifecycleTransitions } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerScanTimeTransitionsQueries } from "../areas/worker-scan-time-transitions.js";

export function pgWorkerScanTimeTransitions(db: PgDb): WorkerScanTimeTransitionsQueries {
  return {
    async listTenants(tenantIds) {
      if (tenantIds && tenantIds.length > 0) {
        return db
          .select({ id: tenants.id, settings: tenants.settings })
          .from(tenants)
          .where(inArray(tenants.id, tenantIds))
          .orderBy(tenants.id);
      }
      return db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .orderBy(tenants.id);
    },

    async listContactsInStatesPage({ tenantId, states, afterId, limit }) {
      // Keyset pagination: fetch next batch of contacts in time-transition states.
      // On the first page, omit the id > $lastId condition.
      const whereConditions = [
        eq(contacts.tenantId, tenantId),
        inArray(contacts.lifecycleState, states),
      ];
      if (afterId !== null) {
        whereConditions.push(gt(contacts.id, afterId));
      }

      return db
        .select({
          id: contacts.id,
          lifecycleState: contacts.lifecycleState,
          lastSeenAt: contacts.lastSeenAt,
        })
        .from(contacts)
        .where(and(...whereConditions))
        .orderBy(contacts.id)
        .limit(limit);
    },

    async applyTimeTransition({ tenantId, contactId, fromState, toState, now }) {
      // Apply via CAS: only succeeds if lifecycle_state still matches.
      const updated = await db
        .update(contacts)
        .set({ lifecycleState: toState })
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.lifecycleState, fromState),
          ),
        )
        .returning({ id: contacts.id });

      if (updated.length === 0) {
        // CAS failed: state was already changed by a concurrent process. No-op.
        return false;
      }

      // CAS succeeded: write audit row.
      await db.insert(lifecycleTransitions).values({
        tenantId,
        contactId,
        fromState,
        toState,
        triggerEventId: null,
        metadata: { trigger: "scan" },
        transitionedAt: now,
      });
      return true;
    },
  };
}
