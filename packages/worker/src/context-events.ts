/**
 * Context packet builder - slice 18.2: cadence and behavior sections.
 *
 * Computes the cadence (7-day event counts and trend) and behavior (last
 * action, recent events, most-used features) sections of the context packet
 * from the partitioned `events` table.
 *
 * Design constraints (from §3.5 [impl] notes and CLAUDE.md):
 *
 * Window column (impl note 11):
 *   Windows are semantically defined against `timestamp` (client-supplied,
 *   when the event happened). Every query ALSO constrains `received_at` so
 *   the Postgres planner can prune partitions. The `received_at` bound is
 *   widened by CADENCE_RECEIVED_AT_SLACK_MS (derived from
 *   INGEST_TIMESTAMP_CLAMP_HOURS in @claros/core, which equals the
 *   TIMESTAMP_CLAMP_HOURS enforced by the ingest route) to cover clients
 *   whose clock runs ahead of server time (timestamp > received_at is
 *   possible; without the slack such events would be excluded by the
 *   pruning filter while being semantically inside the window).
 *   See BACKLOG.md for the compensating-slack note.
 *
 * Trend formula (§3.9):
 *   is_declining = (previous_7d >= 3) AND (current_7d <= previous_7d * 0.5)
 *   Implemented exactly as written; thresholds are not adjusted.
 *
 * most_used_features (impl note 5):
 *   Five most frequent event_name values over the last 30 days.
 *   Tie-break: alphabetical ascending (impl note 13).
 *
 * recent_events (impl note 12):
 *   Ten most recent events, carrying event_name and timestamp only.
 *   Properties are excluded: they are unbounded free-form JSON (token budget
 *   risk) and untrusted text from the tenant's end users (LLM prompt risk).
 *   last_action follows the same rule: event_name and timestamp only.
 *
 * Partitioning:
 *   The events table is partitioned by RANGE (received_at). Every query must
 *   constrain received_at to allow the planner to prune partitions. The
 *   semantic filter on timestamp is separate and applied in addition.
 *
 * All queries are scoped by tenant_id and contact_id.
 * Ordering is always deterministic (ties broken explicitly).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { INGEST_TIMESTAMP_CLAMP_HOURS } from "@claros/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Cadence section of the context packet (§3.5). */
export interface CadenceSection {
  /** Event count in the current 7-day window (now-7d to now). */
  current7d: number;
  /** Event count in the previous 7-day window (now-14d to now-7d). */
  previous7d: number;
  /**
   * Trend label derived from the spec formula:
   *   "declining" if previous_7d >= 3 AND current_7d <= previous_7d * 0.5
   *   "stable" otherwise.
   */
  trend: "declining" | "stable";
}

/** A single event in the recent_events list. */
export interface RecentEvent {
  /** The event name (e.g. "project_created"). null for identify events. */
  eventName: string | null;
  /** ISO-8601 timestamp (client-supplied). */
  timestamp: string;
}

/** Behavior section of the context packet (§3.5). */
export interface BehaviorSection {
  /**
   * The single most recent event: event_name and timestamp only.
   * Properties excluded (impl note 12). Absent if no events exist.
   */
  lastAction?: RecentEvent;
  /**
   * The ten most recent events, each carrying event_name and timestamp only.
   * Properties excluded (impl note 12). Absent if no events exist.
   */
  recentEvents?: RecentEvent[];
  /**
   * Five most frequent event_name values over the last 30 days.
   * Null event_name values (identify events) are excluded from this list
   * because they carry no feature signal.
   * Absent if no qualifying events exist.
   * Tie-break: alphabetical ascending (impl note 13).
   */
  mostUsedFeatures?: string[];
}

/** Result of buildEventSections for a single contact. */
export interface EventSectionsResult {
  cadence: CadenceSection;
  behavior: BehaviorSection;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Slack added to the received_at lower bound so partition pruning does not
 * exclude events whose client timestamp is inside the semantic window but
 * whose received_at is slightly earlier due to clock skew.
 *
 * Derived from INGEST_TIMESTAMP_CLAMP_HOURS in @claros/core - the same
 * constant that governs the ingest route's timestamp clamping. Both sides
 * share the same source so the values cannot drift independently.
 * See BACKLOG.md for the full note.
 */
export const CADENCE_RECEIVED_AT_SLACK_MS = INGEST_TIMESTAMP_CLAMP_HOURS * 60 * 60 * 1000;

/** Cadence window in days. */
export const CADENCE_WINDOW_DAYS = 7;

/** Feature usage window in days. */
export const FEATURES_WINDOW_DAYS = 30;

/** Number of most-used features to return. */
export const MOST_USED_FEATURES_COUNT = 5;

/** Number of recent events to return. */
export const RECENT_EVENTS_COUNT = 10;

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

type CadenceRow = Record<string, unknown> & {
  current_7d: string; // pg COUNT returns bigint as string
  previous_7d: string;
};

type RecentEventRow = Record<string, unknown> & {
  event_name: string | null;
  timestamp: Date | string;
};

type FeatureRow = Record<string, unknown> & {
  event_name: string;
  cnt: string; // bigint as string
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw pg timestamp value to a Date, or null if absent.
 * db.execute() returns timestamp columns as strings; Drizzle ORM select()
 * returns them as Date objects. Both are handled.
 */
function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the cadence trend from the spec formula (§3.9):
 *   is_declining = (previous_7d >= 3) AND (current_7d <= previous_7d * 0.5)
 *
 * Exported for unit testing without a database dependency.
 */
export function computeTrend(current7d: number, previous7d: number): "declining" | "stable" {
  if (previous7d >= 3 && current7d <= previous7d * 0.5) {
    return "declining";
  }
  return "stable";
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Fetch the cadence and behavior sections of the context packet for a
 * single contact.
 *
 * Issues three queries against the partitioned events table:
 *   1. COUNT events in the two consecutive 7-day windows (cadence).
 *   2. SELECT the ten most recent events (recent_events + last_action).
 *   3. SELECT the five most frequent event names in the last 30 days
 *      (most_used_features).
 *
 * All queries constrain both timestamp (semantic) and received_at
 * (partition pruning). See module-level comment for the slack rationale.
 *
 * @param db        - Drizzle database instance (node-postgres).
 * @param tenantId  - The tenant that owns this contact.
 * @param contactId - The contact UUID.
 * @param now       - Current time (injected for testability).
 * @returns Populated cadence and behavior sections.
 */
export async function buildEventSections(
  db: Db,
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<EventSectionsResult> {
  const nowMs = now.getTime();

  // -------------------------------------------------------------------------
  // Window bounds (milliseconds -> ISO strings for SQL)
  // -------------------------------------------------------------------------

  // Cadence windows
  const w7Start = new Date(nowMs - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const w14Start = new Date(nowMs - 2 * CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Features window
  const w30Start = new Date(nowMs - FEATURES_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // received_at pruning bounds: semantic window start minus slack
  const rcvAt7Prune = new Date(w7Start.getTime() - CADENCE_RECEIVED_AT_SLACK_MS);
  const rcvAt14Prune = new Date(w14Start.getTime() - CADENCE_RECEIVED_AT_SLACK_MS);
  const rcvAt30Prune = new Date(w30Start.getTime() - CADENCE_RECEIVED_AT_SLACK_MS);

  // -------------------------------------------------------------------------
  // Query 1: cadence counts
  //
  // Two COUNT FILTER expressions in a single pass over the relevant partitions.
  // received_at >= rcvAt14Prune prunes all partitions older than 14 days + slack.
  // timestamp filters then apply the precise semantic windows.
  // -------------------------------------------------------------------------
  const cadenceRows = await db.execute<CadenceRow>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE timestamp >= ${w7Start.toISOString()}::timestamptz
          AND timestamp  < ${now.toISOString()}::timestamptz
      ) AS current_7d,
      COUNT(*) FILTER (
        WHERE timestamp >= ${w14Start.toISOString()}::timestamptz
          AND timestamp  < ${w7Start.toISOString()}::timestamptz
      ) AS previous_7d
    FROM events
    WHERE contact_id  = ${contactId}
      AND tenant_id   = ${tenantId}
      AND received_at >= ${rcvAt14Prune.toISOString()}::timestamptz
      AND received_at  < ${now.toISOString()}::timestamptz
  `);

  const cadRow = cadenceRows.rows[0]!;
  const current7d = parseInt(cadRow.current_7d, 10) || 0;
  const previous7d = parseInt(cadRow.previous_7d, 10) || 0;

  const cadence: CadenceSection = {
    current7d,
    previous7d,
    trend: computeTrend(current7d, previous7d),
  };

  // -------------------------------------------------------------------------
  // Query 2: recent events (ten most recent, event_name + timestamp only)
  //
  // No lower bound on timestamp needed for recency - we want the most recent
  // regardless of how far back they are. But we still need a received_at
  // constraint to avoid a full-table scan. Use the 30-day window as a
  // practical bound (if there are no events in 30 days, the contact would
  // be dormant/churned and the behavior section will be sparse).
  // Use now + slack as the upper received_at bound to cover edge cases where
  // received_at > now (unlikely but defensive).
  //
  // Ordering: timestamp DESC, then event_name ASC for deterministic tie-break.
  // -------------------------------------------------------------------------
  const recentRows = await db.execute<RecentEventRow>(sql`
    SELECT event_name, timestamp
    FROM events
    WHERE contact_id  = ${contactId}
      AND tenant_id   = ${tenantId}
      AND received_at >= ${rcvAt30Prune.toISOString()}::timestamptz
    ORDER BY timestamp DESC, event_name ASC
    LIMIT ${RECENT_EVENTS_COUNT}
  `);

  // -------------------------------------------------------------------------
  // Query 3: most-used features (five most frequent event_name in last 30 days)
  //
  // Excludes null event_name (identify events carry no feature signal).
  // Tie-break: alphabetical ascending on event_name (impl note 13).
  // -------------------------------------------------------------------------
  const featureRows = await db.execute<FeatureRow>(sql`
    SELECT event_name, COUNT(*) AS cnt
    FROM events
    WHERE contact_id  = ${contactId}
      AND tenant_id   = ${tenantId}
      AND event_name IS NOT NULL
      AND timestamp  >= ${w30Start.toISOString()}::timestamptz
      AND timestamp   < ${now.toISOString()}::timestamptz
      AND received_at >= ${rcvAt30Prune.toISOString()}::timestamptz
      AND received_at  < ${now.toISOString()}::timestamptz
    GROUP BY event_name
    ORDER BY cnt DESC, event_name ASC
    LIMIT ${MOST_USED_FEATURES_COUNT}
  `);

  // -------------------------------------------------------------------------
  // Assemble behavior section
  // -------------------------------------------------------------------------
  const behavior: BehaviorSection = {};

  if (recentRows.rows.length > 0) {
    const mapped: RecentEvent[] = recentRows.rows.map((r) => {
      const ts = toDate(r.timestamp);
      return {
        eventName: r.event_name,
        timestamp: ts != null ? ts.toISOString() : String(r.timestamp),
      };
    });

    // lastAction = most recent (first in DESC-ordered list)
    behavior.lastAction = mapped[0];
    behavior.recentEvents = mapped;
  }

  if (featureRows.rows.length > 0) {
    behavior.mostUsedFeatures = featureRows.rows.map((r) => r.event_name);
  }

  return { cadence, behavior };
}
