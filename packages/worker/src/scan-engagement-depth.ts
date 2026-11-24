/**
 * Scan phase 4: engagement_depth computation.
 *
 * Runs once per scan tick for every tenant. For each tenant it:
 *   1. Reads event_count_bucket_current + event_count_bucket_prev from the
 *      contacts table for all engaged contacts with non-zero totals.
 *   2. Computes the power-user cutoff via percentile_cont, suppressing the
 *      power bucket when the cohort is below floor(1 / power_user_percentile).
 *   3. Writes the resulting depth bucket to contacts.engagement_depth using
 *      IS DISTINCT FROM to avoid write amplification on unchanged rows.
 *
 * Only contacts currently in lifecycle_state = 'engaged' are updated. The
 * column value persists when a contact leaves engaged (last-known observation).
 * Contacts with zero combined event counts are not touched (absence of recent
 * activity is not a reason to overwrite the stored depth).
 *
 * No checkpoint is needed: the phase executes one aggregate SQL query per
 * tenant (O(contacts for the tenant) with idx_contacts_tenant_state),
 * not per-event.
 */
import { eq, and, sql, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, tenants } from "@claros/db/schema";
import {
  resolveLifecycleConfig,
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  type LifecycleConfig,
  type EngagementDepth,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Batch size for the final UPDATE loop.
 * The aggregate query returns one row per engaged contact with non-zero event
 * counts. We write in batches to avoid a single enormous UPDATE statement.
 */
const UPDATE_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseEngagementDepthResult {
  tenantsProcessed: number;
  contactsUpdated: number;
  contactsUnchanged: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 4 of the scan: compute and write engagement_depth for all engaged
 * contacts across all tenants.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed. When omitted, all tenants are processed (production default).
 */
export async function phaseEngagementDepth(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseEngagementDepthResult> {
  const stats: PhaseEngagementDepthResult = {
    tenantsProcessed: 0,
    contactsUpdated: 0,
    contactsUnchanged: 0,
  };

  // Load tenants: use provided list or discover all.
  let tenantRows: { id: string; settings: unknown }[];
  if (tenantIds && tenantIds.length > 0) {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds))
      .orderBy(tenants.id);
  } else {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .orderBy(tenants.id);
  }

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const lifecycleOverrides = settings?.lifecycle as
      | Partial<LifecycleConfig>
      | null
      | undefined;
    const config = resolveLifecycleConfig(lifecycleOverrides);

    const tenantStats = await processTenantEngagementDepth(
      db,
      tenant.id,
      config,
    );

    stats.contactsUpdated += tenantStats.contactsUpdated;
    stats.contactsUnchanged += tenantStats.contactsUnchanged;
    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-tenant processing
// ---------------------------------------------------------------------------

interface TenantDepthResult {
  contactsUpdated: number;
  contactsUnchanged: number;
}

async function processTenantEngagementDepth(
  db: Db,
  tenantId: string,
  config: LifecycleConfig,
): Promise<TenantDepthResult> {
  const minCohort = computeMinCohortSize(config);
  const regularThreshold = computeRegularThreshold(config);

  // -----------------------------------------------------------------------
  // Aggregate query: read event counter columns from engaged contacts and
  // compute the percentile cutoff across the full cohort in one pass.
  //
  // Uses idx_contacts_tenant_state (tenant_id, lifecycle_state) for the
  // initial filter. The counter columns (event_count_bucket_current and
  // event_count_bucket_prev) are maintained by the ingestion path and
  // represent recent activity without scanning the events table.
  // -----------------------------------------------------------------------

  const rows = await db.execute<{
    contact_id: string;
    event_count: string; // pg returns bigint as string
    cohort_size: string;
    power_cutoff: number | null;
  }>(sql`
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
          THEN percentile_cont(${1 - config.power_user_percentile}) WITHIN GROUP (
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

  if (rows.rows.length === 0) {
    return { contactsUpdated: 0, contactsUnchanged: 0 };
  }

  // Compute the power cutoff once (it is the same for every row)
  const firstRow = rows.rows[0]!;
  const rawCutoff = firstRow.power_cutoff;
  // percentile_cont returns a float. We ceil it so that a contact whose
  // event_count equals exactly the computed percentile value (which may be
  // fractional) meets the power threshold.
  const powerCutoff: number | null =
    rawCutoff !== null && rawCutoff !== undefined
      ? Math.ceil(Number(rawCutoff))
      : null;

  // -----------------------------------------------------------------------
  // Build the assignment map: contact_id -> new depth
  // -----------------------------------------------------------------------

  const assignments = new Map<string, EngagementDepth>();

  for (const row of rows.rows) {
    const eventCount = Number(row.event_count);
    const depth = assignEngagementDepth({ eventCount, powerCutoff, regularThreshold });
    if (depth !== null) {
      assignments.set(row.contact_id, depth);
    }
    // depth === null means 0 events - skip, per Q2 decision
  }

  if (assignments.size === 0) {
    return { contactsUpdated: 0, contactsUnchanged: 0 };
  }

  // -----------------------------------------------------------------------
  // Write in batches using IS DISTINCT FROM to skip unchanged rows.
  // The update uses a VALUES list joined to contacts rather than
  // per-row UPDATE statements, keeping round-trips proportional to
  // ceil(assignments.size / UPDATE_BATCH_SIZE).
  // -----------------------------------------------------------------------

  let contactsUpdated = 0;
  let contactsUnchanged = 0;

  const entries = Array.from(assignments.entries());
  for (let i = 0; i < entries.length; i += UPDATE_BATCH_SIZE) {
    const batch = entries.slice(i, i + UPDATE_BATCH_SIZE);

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
    const valueParts = batch.map(
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

    contactsUpdated += result.rows.length;
    contactsUnchanged += batch.length - result.rows.length;
  }

  return { contactsUpdated, contactsUnchanged };
}
