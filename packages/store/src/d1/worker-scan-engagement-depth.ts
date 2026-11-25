/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-scan-engagement-depth.ts.
 *
 * - percentile_cont has no SQLite equivalent: the event counts are fetched
 *   and the cutoff is interpolated in JS exactly like pg's percentile_cont.
 * - The bulk depth update is `SET engagement_depth = CASE id WHEN ... END`
 *   over `(id = ? AND engagement_depth IS NOT ?) OR ...`, chunked so each
 *   statement stays under D1's 100 bound parameters; the chunks run in one
 *   db.batch() (all or nothing, like the single pg statement).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { contacts, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type {
  WorkerScanEngagementDepthQueries,
  WorkerEngagementCountRow,
} from "../areas/worker-scan-engagement-depth.js";

/** (contact_id, depth) pairs per UPDATE: 4 params each plus 2 (tenant, state), under 100. */
const PAIRS_PER_STATEMENT = 24;

/** pg percentile_cont(p) WITHIN GROUP (ORDER BY v ASC) over a non-empty list. */
function percentileCont(sortedAsc: number[], p: number): number {
  const pos = p * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const first = sortedAsc[lo]!;
  if (hi === lo) return first;
  return first + (pos - lo) * (sortedAsc[hi]! - first);
}

export function d1WorkerScanEngagementDepth(db: D1Db): WorkerScanEngagementDepthQueries {
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

    async loadEngagedEventCounts({ tenantId, minCohort, percentile }) {
      const rows = await db.all<{ contact_id: string; event_count: number }>(sql`
        SELECT
          c.id AS contact_id,
          (COALESCE(c.event_count_bucket_current, 0) + COALESCE(c.event_count_bucket_prev, 0)) AS event_count
        FROM contacts c
        WHERE c.tenant_id = ${tenantId}
          AND c.lifecycle_state = 'engaged'
          AND (COALESCE(c.event_count_bucket_current, 0) + COALESCE(c.event_count_bucket_prev, 0)) > 0
      `);
      if (rows.length === 0) return [];
      const cohortSize = rows.length;
      const powerCutoff =
        cohortSize >= minCohort
          ? percentileCont(
              rows.map((r) => Number(r.event_count)).sort((a, b) => a - b),
              percentile,
            )
          : null;
      return rows.map(
        (r): WorkerEngagementCountRow => ({
          contact_id: r.contact_id,
          event_count: String(r.event_count),
          cohort_size: String(cohortSize),
          power_cutoff: powerCutoff,
        }),
      );
    },

    async writeEngagementDepths({ tenantId, assignments }) {
      if (assignments.length === 0) return 0;
      const statements = [];
      for (let i = 0; i < assignments.length; i += PAIRS_PER_STATEMENT) {
        const chunk = assignments.slice(i, i + PAIRS_PER_STATEMENT);
        const caseExpr = sql`CASE ${contacts.id} ${sql.join(
          chunk.map(([id, depth]) => sql`WHEN ${id} THEN ${depth}`),
          sql` `,
        )} END`;
        statements.push(
          db
            .update(contacts)
            .set({ engagementDepth: caseExpr })
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.lifecycleState, "engaged"),
                or(
                  ...chunk.map(([id, depth]) =>
                    and(eq(contacts.id, id), sql`${contacts.engagementDepth} IS NOT ${depth}`),
                  ),
                ),
              ),
            )
            .returning({ id: contacts.id }),
        );
      }
      const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
      return results.reduce((n, rows) => n + rows.length, 0);
    },
  };
}
