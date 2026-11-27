import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    externalId: text("external_id").notNull(), // tenant's user ID
    email: text("email"), // [v2] NULLABLE: identify may arrive before email is known
    name: text("name"),
    // Set when someone edits the name in the dashboard: identify then leaves
    // the name alone until the lock is cleared (DELETE /v1/contacts/:id/name).
    nameLockedAt: integer("name_locked_at", { mode: "timestamp_ms" }),
    company: text("company"),
    properties: text("properties", { mode: "json" }), // arbitrary attributes from track/identify
    lifecycleState: text("lifecycle_state").notNull(), // signed_up|activated|engaged|at_risk|dormant|churned|resurrected
    engagementDepth: text("engagement_depth"), // power|regular|casual|minimal
    paymentStatus: text("payment_status").default("free"), // free|trial|paid|past_due|cancelled
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    // Engagement depth counters: two 15-day buckets approximating a 30-day window.
    // Incremented at ingest time; rolled over by a scheduled job every 15 days.
    // Depth query computes (bucket_current + bucket_prev) at read time.
    eventCountBucketCurrent: integer("event_count_bucket_current").default(0),
    eventCountBucketPrev: integer("event_count_bucket_prev").default(0),
    lastCounterResetAt: integer("last_counter_reset_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("uq_contacts_tenant_external_id").on(
      table.tenantId,
      table.externalId
    ),
    // [v2] email uniqueness via partial index (email is nullable)
    uniqueIndex("uq_contacts_tenant_email")
      .on(table.tenantId, table.email)
      .where(sql`email IS NOT NULL`),
    index("idx_contacts_tenant_state").on(table.tenantId, table.lifecycleState),
    index("idx_contacts_last_seen").on(table.tenantId, table.lastSeenAt),
    // People list cursor pagination: ORDER BY (created_at, id) per tenant.
    index("idx_contacts_tenant_created").on(table.tenantId, table.createdAt, table.id),
  ]
);
