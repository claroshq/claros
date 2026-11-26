/**
 * Queries used by packages/api/src/routes/import.ts (G21 history import:
 * sent messages; events and the lifecycle recompute).
 */
import type { LifecycleState } from "@claros/core";

/** One historical message, validated by the route. */
export interface HistoryImportItem {
  /** Position in the request (for error reports). */
  index: number;
  externalId: string | null;
  email: string | null;
  flowSlug: string;
  stepOrder: number;
  actionType: string;
  subject: string | null;
  sentAt: Date;
  kbExternalKey: string | null;
  /** Idempotency key (caller id or derived). */
  importKey: string;
}

export interface HistoryImportResult {
  imported: number;
  duplicates: number;
  errors: Array<{ index: number; error: string }>;
}

/** One historical track event, validated by the route. */
export interface EventImportItem {
  index: number;
  externalId: string | null;
  email: string | null;
  eventName: string;
  properties: Record<string, unknown> | null;
  timestamp: Date;
  /** Stored as events.message_id: the same dedup key live ingest uses. */
  messageId: string;
}

export interface EventImportResult {
  imported: number;
  duplicates: number;
  contactsCreated: number;
  errors: Array<{ index: number; error: string }>;
}

/** A contact with the history the lifecycle recompute replays. */
export interface LifecycleReplayContact {
  id: string;
  lifecycleState: LifecycleState;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  activatedAt: Date | null;
  lastCounterResetAt: Date | null;
  eventCountBucketCurrent: number;
  eventCountBucketPrev: number;
  engagementDepth: string | null;
  events: Array<{ type: "track" | "identify"; eventName: string | null; timestamp: Date }>;
}

/** The recomputed lifecycle fields for one contact (compare-and-set). */
export interface LifecycleReplayUpdate {
  contactId: string;
  /** Written only while the contact still has this state and last_seen_at. */
  expected: { state: LifecycleState; lastSeenAt: Date | null };
  state: LifecycleState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  activatedAt: Date | null;
  counters: { current: number; prev: number; resetAt: Date };
  /** Replaces the contact's earlier import transitions (metadata source "import"). */
  transitions: Array<{ from: LifecycleState; to: LifecycleState; at: Date; trigger: "event" | "time" }>;
}

export interface ApiImportQueries {
  /**
   * Store historical sent messages (status 'sent', imported = true), each
   * with a completed membership (exit_reason 'imported', entered and
   * completed at sent_at) so re-entry, throttle, history conditions and
   * kb_select exclude_used see them. Contacts resolve by external id, else
   * by email (case-insensitive); flows by slug; KB entries by external key.
   * An item whose import_key exists is a duplicate (nothing written).
   * Unresolvable items are reported in errors. With dryRun nothing is
   * written. Each item is one atomic unit.
   */
  importMessages(input: { tenantId: string; items: HistoryImportItem[]; dryRun: boolean; now: Date }): Promise<HistoryImportResult>;

  /**
   * Store historical track events with their own timestamps (received_at =
   * now). Contacts resolve by external id, else by email; a missing contact
   * with an external id is created (signed_up, first and last seen at its
   * earliest event in the request, no email or traits). An item whose
   * messageId is already stored is a duplicate. Writes events and those
   * contacts only: no lifecycle transition, counter, trait, enrollment,
   * job or webhook. With dryRun nothing is written.
   */
  importEvents(input: { tenantId: string; items: EventImportItem[]; dryRun: boolean; now: Date }): Promise<EventImportResult>;

  /**
   * Up to `limit` contacts with id greater than `afterContactId` (id order),
   * each with its whole event history (type, name, timestamp).
   */
  listLifecycleReplayPage(input: { tenantId: string; afterContactId: string | null; limit: number }): Promise<LifecycleReplayContact[]>;

  /**
   * Write recomputed lifecycle fields, each contact atomically and only
   * while it still has the expected state and last_seen_at (else skipped:
   * an event arrived meanwhile). Replaces the contact's transitions with
   * metadata source "import" by the given ones (metadata {source, trigger}).
   * No enrollment, job or webhook.
   */
  applyLifecycleReplay(input: { tenantId: string; updates: LifecycleReplayUpdate[] }): Promise<{ applied: number; skipped: number }>;

  /** The product's segment-triggered flows (any status), for the dry run report. */
  listSegmentFlows(tenantId: string): Promise<Array<{ slug: string | null; name: string; status: string; triggerConfig: unknown }>>;
}
