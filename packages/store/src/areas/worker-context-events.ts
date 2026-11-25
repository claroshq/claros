/**
 * Queries used by packages/worker/src/context-events.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-context-events.ts (Postgres) and, later,
 * ../d1/worker-context-events.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** One recent event: name and client timestamp (raw driver value). */
export interface WorkerRecentEventRow {
  event_name: string | null;
  timestamp: Date | string;
}

export interface WorkerContextEventsQueries {
  /**
   * Event counts for a contact in [w14Start, w7Start) and [w7Start, now) on
   * timestamp, with received_at constrained to [receivedFrom, now) for
   * partition pruning. Counts are bigint strings.
   */
  countCadenceWindows(input: {
    tenantId: string;
    contactId: string;
    now: Date;
    w7Start: Date;
    w14Start: Date;
    receivedFrom: Date;
  }): Promise<{ current_7d: string; previous_7d: string }>;
  /**
   * The contact's most recent events (timestamp DESC, event_name ASC) among
   * those received at or after receivedFrom.
   */
  listRecentEvents(input: {
    tenantId: string;
    contactId: string;
    receivedFrom: Date;
    limit: number;
  }): Promise<WorkerRecentEventRow[]>;
  /**
   * The contact's most frequent non-null event names with timestamp in
   * [since, now) and received_at in [receivedFrom, now); count DESC, name ASC.
   */
  listMostUsedEventNames(input: {
    tenantId: string;
    contactId: string;
    now: Date;
    since: Date;
    receivedFrom: Date;
    limit: number;
  }): Promise<{ event_name: string; cnt: string }[]>;
}
