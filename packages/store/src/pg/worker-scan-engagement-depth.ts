/**
 * Postgres implementation of the queries used by packages/worker/src/scan-engagement-depth.ts.
 */
import { inArray, sql } from "drizzle-orm";
import { tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type {
  WorkerScanEngagementDepthQueries,
  WorkerEngagementCountRow,
} from "../areas/worker-scan-engagement-depth.js";

export function pgWorkerScanEngagementDepth(db: PgDb): WorkerScanEngagementDepthQueries {
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

    async loadEngagedEventCounts({ tenantId, minCohort, percentile }) {
      // Uses idx_contacts_tenant_state (tenant_id, lifecycle_state) for the
      // initial filter. The counter columns (event_count_bucket_current and
      // event_count_bucket_prev) are maintained by the ingestion path and
      // represent recent activity without scanning the events table.
      const rows = await db.execute<WorkerEngagementCountRow & Record<string, unknown>>(sql`
        WITH event_counts AS (
          SELECT
            c.id AS contact_id,
            (COALESCE(c.event_count_bucket_current, 0) + COALESCE(c.event_count_bucket_prev, 0)) AS event_count
          FROM contacts c
          WHERE
            c.tenant_id = ${tenantId}
            AND c.lifecycle_state = 'engaged'
            AND (COALESCE(c.event_count_bucket_current, 0) + COALESCE(c.event_count_bucket_prev, 0)) > 0
        ),
        cohort AS (
          SELECT COUNT(*) AS cohort_size FROM event_counts
        ),
        percentile AS (
          SELECT
            CASE
              WHEN (SELECT cohort_size FROM cohort) >= ${minCohort}
              THEN percentile_cont(${percentile}) WITHIN GROUP (
                     ORDER BY event_count ASC
                   )
              ELSE NULL
            END AS power_cutoff
          FROM event_counts
        )
        SELECT
          ec.contact_id,
          ec.event_count,
          (SELECT cohort_size FROM cohort)  AS cohort_size,
          (SELECT power_cutoff FROM percentile) AS power_cutoff
        FROM event_counts ec
      `);
      return rows.rows;
    },

    async writeEngagementDepths({ tenantId, assignments }) {
      // Build a CASE expression for this batch.
      // UPDATE contacts SET engagement_depth = CASE id WHEN $1 THEN $2 ... END
      // WHERE id IN (...) AND tenant_id = $tenantId AND ...
      //
      // Drizzle does not have a built-in CASE-over-values for bulk updates, so
      // we use raw SQL for this statement. The contact IDs and depth values are
      // all application-validated (UUIDs from PG, depth values from our own
      // assignEngagementDepth function), so the interpolation is safe.

      // Build VALUES: (contact_id::uuid, depth::text)
      // We emit these as a sql`` template so drizzle parameterises them.
      const valueParts = assignments.map(
        ([id, depth]) => sql`(${id}::uuid, ${depth}::text)`,
      );

      // Combine with commas
      const valuesList = valueParts.reduce(
        (acc, part, idx) => (idx === 0 ? part : sql`${acc}, ${part}`),
      );

      const result = await db.execute<{ id: string }>(sql`
        UPDATE contacts c
        SET engagement_depth = v.depth
        FROM (VALUES ${valuesList}) AS v(contact_id, depth)
        WHERE
          c.id          = v.contact_id
          AND c.tenant_id   = ${tenantId}
          AND c.lifecycle_state = 'engaged'
          AND c.engagement_depth IS DISTINCT FROM v.depth
        RETURNING c.id
      `);
      return result.rows.length;
    },
  };
}
