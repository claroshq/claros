import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/**
 * Records rejected trait updates that could not be applied to a contact.
 *
 * Two cases produce conflict rows:
 * 1. Email conflict: identify carries an email already held by another contact
 *    in the same tenant. The partial unique index (uq_contacts_tenant_email)
 *    enforces this. Per spec section 0 item 5: "reject the email update, keep
 *    the event, surface the conflict in admin. Contact merge is V2."
 * 2. Invalid payment_status: identify sends a payment_status value outside the
 *    allowed enum (free|trial|paid|past_due|cancelled). The value is not
 *    silently discarded - it is recorded here so it is visible to the admin.
 *
 * No resolution workflow or status column - that is V2 (contact merge).
 *
 * [impl] Satisfies the "surface to admin" requirement of spec section 0 item 5.
 */
export const contactConflicts = sqliteTable(
  "contact_conflicts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    field: text("field").notNull(), // e.g. "email", "payment_status"
    rejectedValue: text("rejected_value").notNull(), // the value that was rejected
    // event_id references events.id logically but the FK constraint cannot
    // exist because events is partitioned (PK includes received_at; a FK on
    // event_id alone has no matching unique index). Referential integrity is
    // guaranteed by the ingest code path which inserts the event and conflict
    // in the same request.
    eventId: text("event_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_contact_conflicts_tenant").on(table.tenantId, table.createdAt),
    index("idx_contact_conflicts_contact").on(table.contactId),
  ]
);
