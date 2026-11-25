/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-enroll.ts.
 *
 * Same guard order and results as the Postgres implementation:
 *   1. Suppression check (contact's email in suppressions table)
 *   2. Class-based concurrency (nurture: one active at a time, with priority eviction)
 *   3. Re-entry policy check
 *   4. INSERT with ON CONFLICT DO NOTHING (race backstop)
 *
 * Concurrency: D1 has no advisory locks and no interactive transactions. The
 * invariant "at most one active nurture-class membership per contact" is held
 * by the writes themselves, each a single atomic statement (D1 serialises
 * writes):
 *   - the eviction UPDATE only exits lower-priority active nurture
 *     memberships, and only when no active nurture membership with priority
 *     >= the new flow's exists;
 *   - the nurture INSERT is `INSERT ... SELECT ... WHERE NOT EXISTS (active
 *     nurture membership for the contact)`;
 *   - eviction and insert run in one db.batch() (all or nothing, no other
 *     write in between).
 * A concurrent enrollment that loses the race gets
 * { enrolled: false, reason: "concurrent_enrollment" }. The reads before the
 * writes (suppression, existing priority, re-entry) only choose the reason.
 */
import { eq, and, desc, ne, sql } from "drizzle-orm";
import { contacts, flows, flowMemberships, suppressions } from "@claros/db/schema-sqlite";
import {
  sortByPriority,
  isReentryAllowed,
  type EnrollableFlow,
  type PriorMembership,
} from "@claros/core";
import type { D1Db } from "./db.js";
import { d1OutboxEndpoints, d1OutboxInserts, d1OutboxFromSelect, type OutboxEndpoints } from "./outbox.js";
import type { WorkerEnrollQueries, WorkerEnrollResult } from "../areas/worker-enroll.js";

/** Active nurture-class membership of the contact (correlated predicate body). */
function activeNurtureExists(contactId: string, minPriority?: number) {
  return sql`SELECT 1 FROM flow_memberships fm
    JOIN flows f ON f.id = fm.flow_id
    WHERE fm.contact_id = ${contactId}
      AND fm.status = 'active'
      AND f.flow_class = 'nurture'
      ${minPriority === undefined ? sql`` : sql`AND COALESCE(f.priority, 0) >= ${minPriority}`}`;
}

async function isSuppressed(db: D1Db, tenantId: string, contactId: string): Promise<boolean> {
  const contactRows = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  const contactEmail = contactRows[0]?.email;
  if (!contactEmail) return false;
  const suppressed = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.tenantId, tenantId), eq(suppressions.email, contactEmail)))
    .limit(1);
  return suppressed.length > 0;
}

async function reentryAllowed(
  db: D1Db,
  contactId: string,
  flow: EnrollableFlow,
  now: Date,
): Promise<boolean> {
  const prior = await db
    .select({
      exitedAt: flowMemberships.exitedAt,
      completedAt: flowMemberships.completedAt,
      exitReason: flowMemberships.exitReason,
    })
    .from(flowMemberships)
    .where(
      and(
        eq(flowMemberships.contactId, contactId),
        eq(flowMemberships.flowId, flow.id),
        ne(flowMemberships.status, "active"),
      ),
    )
    .orderBy(desc(flowMemberships.enteredAt))
    .limit(1);
  const priorMembership: PriorMembership | null = prior[0]
    ? { exitedAt: prior[0].exitedAt, completedAt: prior[0].completedAt, exitReason: prior[0].exitReason }
    : null;
  return isReentryAllowed(
    flow.reentryPolicy as "once" | "cooldown" | "every_time",
    flow.reentryCooldownDays,
    priorMembership,
    now,
  );
}

async function attemptEnrollment(
  db: D1Db,
  flow: EnrollableFlow,
  tenantId: string,
  contactId: string,
  suppressed: boolean,
  now: Date,
  endpoints: OutboxEndpoints = [],
): Promise<WorkerEnrollResult> {
  // G5: flow.enrolled after the guarded insert, flow.exited for the evicted
  // membership, both in the insert's batch (the enrolled event is guarded by
  // changes(), so a refused insert writes nothing).
  const membershipId = crypto.randomUUID();
  const enrolledEvent = () =>
    d1OutboxInserts(db, tenantId, endpoints, [{ event: "flow.enrolled", payload: { membership_id: membershipId, contact_id: contactId, flow_id: flow.id } }], now, { afterChange: true });
  const evictedEvent = () =>
    d1OutboxFromSelect(
      db,
      tenantId,
      endpoints,
      "flow.exited",
      sql`flow_memberships src`,
      sql`src.contact_id = ${contactId} AND src.status = 'exited' AND src.exit_reason = 'priority_override' AND src.exited_at = ${now.getTime()}`,
      sql`json_object('membership_id', src.id, 'contact_id', src.contact_id, 'flow_id', src.flow_id, 'reason', 'priority_override')`,
      now,
    );
  // Guard 1: suppression
  if (suppressed) return { enrolled: false, reason: "suppressed" };

  if (flow.flowClass !== "nurture") {
    // Critical class: no concurrency limit.
    if (!(await reentryAllowed(db, contactId, flow, now))) {
      return { enrolled: false, reason: "reentry_blocked" };
    }
    const insertCritical = db
      .insert(flowMemberships)
      .values({
        id: membershipId,
        tenantId,
        contactId,
        flowId: flow.id,
        currentStep: 1,
        status: "active",
        enteredAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: flowMemberships.id });
    const [inserted] = (await db.batch([insertCritical, ...enrolledEvent()] as never)) as Array<Array<{ id: string }>>;
    if (!inserted || inserted.length === 0) return { enrolled: false, reason: "concurrent_enrollment" };
    return { enrolled: true, membershipId: inserted[0]!.id, evictedMembershipId: undefined };
  }

  // Guard 2: class-based concurrency (read to pick the reason; the writes
  // below re-check atomically).
  const active = await db
    .select({ membershipId: flowMemberships.id, flowPriority: flows.priority })
    .from(flowMemberships)
    .innerJoin(flows, eq(flowMemberships.flowId, flows.id))
    .where(
      and(
        eq(flowMemberships.contactId, contactId),
        eq(flowMemberships.status, "active"),
        eq(flows.flowClass, "nurture"),
      ),
    );
  let mustEvict = false;
  if (active.length > 0) {
    const existingPriority = active[0]!.flowPriority ?? 0;
    if (existingPriority >= flow.priority) {
      return {
        enrolled: false,
        reason: `nurture_concurrency:existing_priority_${existingPriority}_>=_new_${flow.priority}`,
      };
    }
    mustEvict = true;
  }

  // Eviction of lower-priority active nurture memberships, guarded so it
  // never fires when an equal-or-higher-priority one is active.
  const evict = db
    .update(flowMemberships)
    .set({ status: "exited", exitedAt: now, exitReason: "priority_override" })
    .where(
      and(
        eq(flowMemberships.contactId, contactId),
        eq(flowMemberships.status, "active"),
        sql`${flowMemberships.flowId} IN (
          SELECT id FROM flows WHERE flow_class = 'nurture' AND COALESCE(priority, 0) < ${flow.priority}
        )`,
        sql`NOT EXISTS (${activeNurtureExists(contactId, flow.priority)})`,
      ),
    )
    .returning({ id: flowMemberships.id });

  // Guard 3: re-entry policy. Postgres evicts before checking re-entry, so an
  // eviction still happens when re-entry then blocks; keep that order.
  if (!(await reentryAllowed(db, contactId, flow, now))) {
    if (mustEvict) {
      const ev = evictedEvent();
      await db.batch((ev ? [evict, ev] : [evict]) as never);
    }
    return { enrolled: false, reason: "reentry_blocked" };
  }

  // Guard 4: guarded insert (no active nurture membership) with the
  // uq_flow_membership_active backstop.
  // insert().select(sql) lists every flow_memberships column in schema order:
  // id, tenant_id, contact_id, flow_id, current_step, status, entered_at,
  // completed_at, exited_at, exit_reason, condition_error.
  const insert = db
    .insert(flowMemberships)
    .select(sql`
      SELECT ${membershipId}, ${tenantId}, ${contactId}, ${flow.id}, 1, 'active', ${now.getTime()},
             NULL, NULL, NULL, NULL
      WHERE NOT EXISTS (${activeNurtureExists(contactId)})
    `)
    .onConflictDoNothing()
    .returning({ id: flowMemberships.id });

  const ev = evictedEvent();
  const [evicted, inserted] = (await db.batch([evict, insert, ...enrolledEvent(), ...(ev ? [ev] : [])] as never)) as Array<Array<{ id: string }>>;
  if (inserted.length === 0) return { enrolled: false, reason: "concurrent_enrollment" };
  return {
    enrolled: true,
    membershipId: inserted[0]!.id,
    evictedMembershipId: evicted[0]?.id,
  };
}

export function d1WorkerEnroll(db: D1Db): WorkerEnrollQueries {
  return {
    async enrollContactInFlows({ contactId, tenantId, candidateFlows, now }) {
      if (candidateFlows.length === 0) return [];

      const sorted = sortByPriority(candidateFlows);
      const results: WorkerEnrollResult[] = [];
      const criticalFlows = sorted.filter((f) => f.flowClass === "critical");
      const nurtureFlows = sorted.filter((f) => f.flowClass === "nurture");
      const suppressed = await isSuppressed(db, tenantId, contactId);
      const endpoints = await d1OutboxEndpoints(db, tenantId, [{ event: "flow.enrolled", payload: {} }]);

      for (const flow of criticalFlows) {
        results.push(await attemptEnrollment(db, flow, tenantId, contactId, suppressed, now, endpoints));
      }

      let nurtureEnrolled = false;
      for (const flow of nurtureFlows) {
        if (nurtureEnrolled) {
          results.push({ enrolled: false, reason: "nurture_concurrency:higher_priority_enrolled" });
          continue;
        }
        const result = await attemptEnrollment(db, flow, tenantId, contactId, suppressed, now, endpoints);
        results.push(result);
        if (result.enrolled) nurtureEnrolled = true;
        if (!result.enrolled && result.reason.startsWith("nurture_concurrency:existing_priority")) {
          for (let i = nurtureFlows.indexOf(flow) + 1; i < nurtureFlows.length; i++) {
            results.push({ enrolled: false, reason: result.reason });
          }
          break;
        }
      }
      return results;
    },
  };
}
