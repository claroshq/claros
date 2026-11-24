import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/**
 * Events table - behavioral events from track/identify calls.
 *
 * PARTITIONING NOTE: The real Postgres table is PARTITION BY RANGE (received_at)
 * with monthly partitions. The real primary key is (id, received_at) because
 * Postgres requires the partition key in the PK. Drizzle's .primaryKey() on id
 * alone is a representational limitation of the ORM.
 *
 * INVARIANT: Never query events by id alone without an additional filter
 * (tenant_id, contact_id, or received_at range). A bare WHERE id = $1 scans
 * every partition's PK index. No such query exists today; this comment is what
 * stops one appearing later.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    type: text("type").notNull(), // track|identify
    eventName: text("event_name"), // e.g., "project_created"
    properties: text("properties", { mode: "json" }),
    context: text("context", { mode: "json" }), // device, ip, etc.
    messageId: text("message_id"), // client-generated dedup key (Segment-compatible)
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_events_contact_time").on(table.contactId, table.timestamp),
    index("idx_events_tenant_name").on(
      table.tenantId,
      table.eventName,
      table.timestamp
    ),
    // Covers queries that filter by tenant + time range (e.g., step-advancement
    // hasEventSince, future date-property trigger scans).
    index("idx_events_tenant_time").on(table.tenantId, table.timestamp),
    // Dedup lookup: non-unique because uniqueness is enforced via advisory lock
    // in the ingest transaction, not via a constraint (partition key would have
    // to be included in a unique index, defeating the purpose).
    index("idx_events_dedup_lookup")
      .on(table.tenantId, table.messageId)
      .where(sql`message_id IS NOT NULL`),
  ]
);
