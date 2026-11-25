import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { flows } from "./flows.js";

export const flowMemberships = sqliteTable(
  "flow_memberships",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    currentStep: integer("current_step").notNull().default(1),
    status: text("status").default("active").notNull(), // active|completed|exited|paused
    enteredAt: integer("entered_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    exitedAt: integer("exited_at", { mode: "timestamp_ms" }),
    exitReason: text("exit_reason"), // completed|condition_met|admin|priority_override
    // [impl] task 12d: records last-observed condition evaluation error.
    // Non-null means the scan could not interpret a condition on the current step
    // or plan-level exit. The membership stays active but unadvanced until the
    // flow is recompiled with a valid condition vocabulary. Self-clears when the
    // condition becomes parseable on a subsequent scan pass.
    conditionError: text("condition_error"),
    /** Date triggers (G3): the anchor date this membership was enrolled for. */
    anchorAt: integer("anchor_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    // [v2] Only ONE ACTIVE membership per flow per contact
    uniqueIndex("uq_flow_membership_active")
      .on(table.contactId, table.flowId)
      .where(sql`status = 'active'`),
    // G3: one enrollment per (flow, contact, anchor date), whatever its status.
    uniqueIndex("uq_flow_membership_anchor")
      .on(table.tenantId, table.flowId, table.contactId, table.anchorAt)
      .where(sql`anchor_at IS NOT NULL`),
    index("idx_flow_members_contact").on(table.contactId, table.status),
    index("idx_flow_members_flow").on(
      table.flowId,
      table.status,
      table.currentStep
    ),
  ]
);
