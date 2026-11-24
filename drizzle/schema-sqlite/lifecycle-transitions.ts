import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

export const lifecycleTransitions = sqliteTable("lifecycle_transitions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  contactId: text("contact_id")
    .notNull()
    .references(() => contacts.id),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  // trigger_event_id references events.id logically but has no FK constraint.
  // Originally: audit log must survive event pruning (retention drops old partitions).
  // Additionally: events is partitioned by received_at with PK (id, received_at),
  // so a FK on event_id alone has no matching unique index. Referential integrity
  // is guaranteed by the ingest code path (evaluateAndApplyTransition writes the
  // transition row immediately after the event INSERT in the same request handler).
  triggerEventId: text("trigger_event_id"),
  metadata: text("metadata", { mode: "json" }),
  transitionedAt: integer("transitioned_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  // Person timeline transitions branch: WHERE contact_id ORDER BY transitioned_at DESC.
  index("idx_transitions_contact").on(table.contactId, table.transitionedAt),
  // Analytics movement queries: per-tenant range scans on transitioned_at.
  index("idx_transitions_tenant_time").on(table.tenantId, table.transitionedAt),
]);
