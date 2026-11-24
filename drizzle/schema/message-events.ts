import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { lifecycleMessages } from "./lifecycle-messages.js";

/**
 * message_events - delivery event log for lifecycle messages.
 *
 * Records every delivery event reported by the transport provider: delivered,
 * opened, clicked, bounced, complained. Each row is one event occurrence with
 * its own timestamp, enabling per-day open/click trends and a real timeline
 * on the message detail screen.
 *
 * Coexistence with lifecycle_messages.feedback:
 *   The existing advance-only `feedback` column remains and continues to be
 *   updated by advanceFeedback(). It serves as a fast materialized summary
 *   for aggregate queries (Analytics). This table is the source of truth for
 *   the full event history.
 *
 * Idempotency:
 *   Providers retry webhook delivery. The partial unique index on
 *   (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
 *   deduplicates retries. Events without a provider ID (e.g. synthetic
 *   events from future transports) are not deduplicated by this constraint.
 *
 * Growth bounds:
 *   The application layer enforces a per-message cap (50 events). Beyond that,
 *   a future retention policy can truncate old engagement events (opens/clicks)
 *   while preserving terminal events (bounces/complaints) indefinitely.
 */
export const messageEvents = pgTable(
  "message_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => lifecycleMessages.id),
    eventType: text("event_type").notNull(), // delivered|opened|clicked|bounced|complained
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    providerEventId: text("provider_event_id"), // provider's unique event ID for dedup
    metadata: jsonb("metadata"), // bounce type, click URL, user agent, etc.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Timeline query: all events for one message, ordered by time
    index("idx_message_events_message").on(
      table.messageId,
      table.occurredAt
    ),
    // Per-day trend queries: tenant-scoped, event_type filter, occurred_at range
    index("idx_message_events_tenant_type_day").on(
      table.tenantId,
      table.eventType,
      table.occurredAt
    ),
    // Idempotency: deduplicate provider webhook retries.
    // Partial: only rows with a non-null provider_event_id are constrained.
    uniqueIndex("uq_message_events_provider_dedup")
      .on(table.tenantId, table.providerEventId)
      .where(sql`provider_event_id IS NOT NULL`),
  ]
);
