import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    externalId: text("external_id").notNull(), // tenant's user ID
    email: text("email"), // [v2] NULLABLE: identify may arrive before email is known
    name: text("name"),
    // Set when someone edits the name in the dashboard: identify then leaves
    // the name alone until the lock is cleared (DELETE /v1/contacts/:id/name).
    nameLockedAt: timestamp("name_locked_at", { withTimezone: true }),
    company: text("company"),
    properties: jsonb("properties"), // arbitrary attributes from track/identify
    lifecycleState: text("lifecycle_state").notNull(), // signed_up|activated|engaged|at_risk|dormant|churned|resurrected
    engagementDepth: text("engagement_depth"), // power|regular|casual|minimal
    paymentStatus: text("payment_status").default("free"), // free|trial|paid|past_due|cancelled
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Engagement depth counters: two 15-day buckets approximating a 30-day window.
    // Incremented at ingest time; rolled over by a scheduled job every 15 days.
    // Depth query computes (bucket_current + bucket_prev) at read time.
    eventCountBucketCurrent: integer("event_count_bucket_current").default(0),
    eventCountBucketPrev: integer("event_count_bucket_prev").default(0),
    lastCounterResetAt: timestamp("last_counter_reset_at", { withTimezone: true }),
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
