/**
 * Queries used by packages/api/src/routes/analytics.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-analytics.ts (Postgres) and, later,
 * ../d1/api-analytics.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 *
 * Windows given as `days` are relative to the database clock: rows with the
 * timestamp >= now() - days. Day buckets are UTC calendar days as 'YYYY-MM-DD'
 * text, ordered ascending.
 *
 * `audience` (optional, default "all") restricts a read to paying or free
 * contacts by their CURRENT payment_status (see ../shared/audience.ts). For
 * transitions this means "transitions of contacts who are paid now", not
 * "transitions made while paid": payment status is not recorded per
 * transition.
 */

import type { ContactAudience } from "@claros/core";

/** Message counts by outcome. */
export type SendingCounts = {
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  suppressed: number;
  failed: number;
};

export interface ApiAnalyticsQueries {
  /** The tenant's settings JSON (null when unset or the tenant does not exist). */
  getTenantSettings(input: { tenantId: string }): Promise<unknown>;
  /** Current contact count per lifecycle state, split by engagement depth (unset = no depth). */
  lifecycleDistribution(input: { tenantId: string; audience?: ContactAudience }): Promise<Array<{
    state: string;
    total: number;
    power: number;
    regular: number;
    casual: number;
    minimal: number;
    unset: number;
  }>>;
  /** Transitions into and out of each state within the window. */
  movementPerState(input: { tenantId: string; days: number; audience?: ContactAudience }): Promise<Array<{ state: string; entered: number; exited: number }>>;
  /** The 20 most frequent state-to-state transitions within the window, most frequent first. */
  movementEdges(input: { tenantId: string; days: number; audience?: ContactAudience }): Promise<Array<{ from_state: string; to_state: string; count: number }>>;
  /**
   * Transitions per day within the window: positive = into activated/engaged/
   * resurrected, negative = into at_risk/dormant/churned.
   */
  movementDays(input: { tenantId: string; days: number; audience?: ContactAudience }): Promise<Array<{ day: string; count: number; positive: number; negative: number }>>;
  /** Messages sent per day (sent_at within the window). */
  sendDays(input: { tenantId: string; days: number }): Promise<Array<{ day: string; sent: number }>>;
  /**
   * Outcome totals for messages created within the window (opened counts
   * opened or clicked); null when no row comes back.
   */
  sendingTotals(input: { tenantId: string; days: number }): Promise<SendingCounts | null>;
  /** Outcome totals per flow for messages created within the window, most sent first, at most 100 flows. */
  sendingPerFlow(input: { tenantId: string; days: number }): Promise<Array<SendingCounts & { flow_id: string; flow_name: string }>>;
  /** Opened, clicked and bounced message events per day within the window. */
  engagementDays(input: { tenantId: string; days: number }): Promise<Array<{ day: string; opens: number; clicks: number; bounces: number }>>;
  /** Day ('YYYY-MM-DD') of the tenant's earliest message event, or null. */
  earliestEngagementDay(input: { tenantId: string }): Promise<string | null>;
  /**
   * Current contact counts per retention-grid cell (tenure x recency) and how
   * many of them pay (payment_status paid or past_due). Threshold values are
   * day counts computed by the caller.
   */
  retentionGridCells(input: {
    tenantId: string;
    tenureThresholdsDays: { growing: number; established: number; loyal: number };
    recencyThresholdsDays: { cooling: number; idle: number; dormant: number };
  }): Promise<Array<Record<string, unknown> & { tenure: string; recency: string; count: number; paying: number }>>;
  /**
   * Contacts in one retention-grid cell given as day ranges (max null = open
   * ended), keyset-paginated on id ascending after the cursor id.
   */
  retentionCellContacts(input: {
    tenantId: string;
    tenure: { minDays: number; maxDays: number | null };
    recency: { minDays: number; maxDays: number | null };
    afterId: string | null;
    limit: number;
    audience?: ContactAudience;
  }): Promise<Array<{
    id: string;
    external_id: string;
    email: string | null;
    name: string | null;
    lifecycle_state: string;
    payment_status: string | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
  }>>;
  /** Daily snapshots of one retention-grid cell within the last `days` UTC days, oldest first. */
  retentionCellTrend(input: {
    tenantId: string;
    tenure: string;
    recency: string;
    days: number;
  }): Promise<Array<{ day: string; count: number; paying: number }>>;
}
