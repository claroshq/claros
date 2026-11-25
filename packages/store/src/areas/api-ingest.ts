/**
 * Queries used by packages/api/src/routes/ingest.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-ingest.ts (Postgres) and, later,
 * ../d1/api-ingest.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** Identify traits split into reserved columns, properties to merge, keys to unset and rejected values. */
export interface IngestTraitPlan {
  columnUpdates: {
    email?: string | null;
    name?: string | null;
    company?: string | null;
    paymentStatus?: string | null;
  };
  propsToMerge: Record<string, unknown>;
  keysToRemove: string[];
  conflicts: Array<{ field: string; rejectedValue: string }>;
}

export interface IngestTrackInput {
  tenantId: string;
  /** contacts.external_id */
  userId: string;
  eventName: string;
  properties: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  /** Client messageId; a non-empty value turns on at-most-once dedup. */
  messageId?: string | undefined;
  /** Event timestamp (already clamped by the caller). */
  timestamp: Date;
  /** Server receive time (last_seen_at, transition time). */
  now: Date;
}

export interface IngestIdentifyInput {
  tenantId: string;
  /** contacts.external_id */
  userId: string;
  /** Raw traits, stored as the identify event's properties. */
  traits: Record<string, unknown> | null;
  /** Partitioned traits, or null when traits are absent or empty (contact is only ensured). */
  traitPlan: IngestTraitPlan | null;
  context: Record<string, unknown> | null;
  /** Client messageId; a non-empty value turns on at-most-once dedup. */
  messageId?: string | undefined;
  /** Event timestamp (already clamped by the caller). */
  timestamp: Date;
  /** Server receive time (last_seen_at, transition time). */
  now: Date;
}

export interface ApiIngestQueries {
  /**
   * Record a track event: contact find-or-create (last_seen_at, event counter),
   * event insert, lifecycle transition CAS + audit row. With a messageId all of it
   * runs in one transaction behind an advisory lock on (tenant, messageId), so each
   * messageId is inserted at most once; without one, statements run unwrapped.
   */
  recordTrackEvent(
    input: IngestTrackInput,
  ): Promise<{ deduplicated: true } | { deduplicated: false; contactId: string }>;
  /**
   * Record an identify event: contact upsert with trait merge (atomic jsonb merge,
   * email-conflict detection with one retry), event insert, conflict rows, lifecycle
   * transition CAS + audit row. Same messageId dedup and transaction rules as
   * recordTrackEvent.
   */
  recordIdentifyEvent(input: IngestIdentifyInput): Promise<{ deduplicated: boolean }>;
  /**
   * Apply an identify `topics` trait ({ <slug>: boolean }) to the contact with this external id:
   * true -> 'subscribed', false -> 'unsubscribed' (source as given). Slugs that are not topics of
   * the tenant are returned in `unknown` and ignored. All writes are one atomic unit.
   */
  /**
   * G3: when an identify changed (set or unset) any of the product's declared
   * date traits (settings.date_traits), rewrite the contact_dates rows of the
   * contact with this external id from its current properties. Returns the
   * number of date rows written (0 when no declared trait was touched).
   */
  syncContactDates(input: { tenantId: string; externalId: string; changedKeys: readonly string[]; now: Date }): Promise<number>;
  applyContactTopics(input: {
    tenantId: string;
    externalId: string;
    topics: Record<string, boolean>;
    source: string;
    now: Date;
  }): Promise<{ applied: string[]; unknown: string[] }>;
}
