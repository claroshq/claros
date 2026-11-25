/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-time-transitions.ts.
 */
import { eq, and, inArray, gt } from "drizzle-orm";
import { contacts, tenants, lifecycleTransitions } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { WorkerScanTimeTransitionsQueries } from "../areas/worker-scan-time-transitions.js";

export function d1WorkerScanTimeTransitions(db: D1Db): WorkerScanTimeTransitionsQueries {
  return {
    async listTenants(tenantIds) {
      if (tenantIds && tenantIds.length > 0) {
        const out: { id: string; settings: unknown }[] = [];
        for (let i = 0; i < tenantIds.length; i += 90) {
          out.push(
            ...(await db
              .select({ id: tenants.id, settings: tenants.settings })
              .from(tenants)
              .where(inArray(tenants.id, tenantIds.slice(i, i + 90)))),
          );
        }
        return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      return db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .orderBy(tenants.id);
    },

    async listContactsInStatesPage({ tenantId, states, afterId, limit }) {
      if (states.length === 0) return [];
      return db
        .select({
          id: contacts.id,
          lifecycleState: contacts.lifecycleState,
          lastSeenAt: contacts.lastSeenAt,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            inArray(contacts.lifecycleState, states),
            afterId === null ? undefined : gt(contacts.id, afterId),
          ),
        )
        .orderBy(contacts.id)
        .limit(limit);
    },

    async applyTimeTransition({ tenantId, contactId, fromState, toState, now }) {
      // CAS on lifecycle_state; the audit row is written only when it succeeded.
      const updated = await db
        .update(contacts)
        .set({ lifecycleState: toState })
        .where(and(eq(contacts.id, contactId), eq(contacts.lifecycleState, fromState)))
        .returning({ id: contacts.id });
      if (updated.length === 0) return false;

      await db.insert(lifecycleTransitions).values({
        id: crypto.randomUUID(),
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
