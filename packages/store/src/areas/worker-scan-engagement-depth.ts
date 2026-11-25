/**
 * Queries used by packages/worker/src/scan-engagement-depth.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-engagement-depth.ts (Postgres) and, later,
 * ../d1/worker-scan-engagement-depth.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** One engaged contact's recent event count plus the cohort-wide figures. */
export interface WorkerEngagementCountRow {
  contact_id: string;
  /** bigint as string (raw pg result). */
  event_count: string;
  /** bigint as string (raw pg result). */
  cohort_size: string;
  /** Percentile cutoff (float) or null when the cohort is below minCohort. */
  power_cutoff: number | null;
}

export interface WorkerScanEngagementDepthQueries {
  /** Tenants (id, settings) ordered by id; restricted to tenantIds when given and non-empty. */
  listTenants(tenantIds?: string[]): Promise<{ id: string; settings: unknown }[]>;
  /**
   * Engaged contacts with a non-zero recent event count (current + previous
   * counter bucket), each with the cohort size and the cohort's
   * `percentile` (0..1, ascending) event-count cutoff, null when the cohort
   * has fewer than minCohort contacts.
   */
  loadEngagedEventCounts(input: {
    tenantId: string;
    minCohort: number;
    percentile: number;
  }): Promise<WorkerEngagementCountRow[]>;
  /**
   * Write engagement_depth for a batch of (contactId, depth) pairs, only on
   * contacts still engaged and only where the value changes. Returns the
   * number of rows actually updated.
   */
  writeEngagementDepths(input: {
    tenantId: string;
    assignments: Array<[contactId: string, depth: string]>;
  }): Promise<number>;
}
