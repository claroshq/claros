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
import { flowMemberships } from "./flow-memberships.js";

export const lifecycleMessages = sqliteTable(
  "lifecycle_messages",
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
    membershipId: text("membership_id")
      .notNull()
      .references(() => flowMemberships.id),
    flowStepOrder: integer("flow_step_order"),
    status: text("status").notNull(), // pending_generation|generating|awaiting_content|pending_approval|approved|sending|sent|failed|suppressed|skipped|value_gated|rejected
    feedback: text("feedback"), // opened|clicked|bounced|complained - ADVANCE-ONLY (see BACKLOG.md "Advance-only feedback guards")
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    brainReasoning: text("brain_reasoning"), // why Brain chose this action
    brainActionType: text("brain_action_type"), // from catalog
    scheduledSendAt: integer("scheduled_send_at", { mode: "timestamp_ms" }),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    retryCount: integer("retry_count").default(0),
    providerMessageId: text("provider_message_id"), // nullable; written on successful send with the ID returned by the provider
    // [impl] recipient_address (task 28, step 0): written by the drain BEFORE the send attempt,
    // recording the address this message was prepared for. It is set even on messages that
    // subsequently failed or were left in 'sending' by reap. It is NOT a send confirmation -
    // the unsubscribe endpoint requires status = 'sent' in addition to this column being
    // non-null. The pre-send write covers the crash window: if the process dies after the
    // provider accepts the message but before the post-send DB write, the recipient address
    // is still resolvable. Column was originally named delivered_to; renamed before migration
    // 0015 was ever applied to production.
    recipientAddress: text("recipient_address"),
    /** Topic copied from the flow when the message is created (G8a); null = no topic. */
    topicId: text("topic_id"),
    /** Transport the message was sent through (transport_configs.id), when known. */
    transportId: text("transport_id"),
    /** Why the message reached a terminal non-sent state (topic_unsubscribed, transport_policy), when recorded. */
    statusReason: text("status_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  },
  (table) => [
    // Drain worker query: only approved/sending messages matter
    index("idx_messages_drain")
      .on(table.tenantId, table.status, table.scheduledSendAt)
      .where(sql`status IN ('approved', 'sending')`),
    index("idx_messages_contact").on(
      table.contactId,
      table.status,
      table.createdAt
    ),
    // Throttle gate frequency cap query: count recent sends per contact.
    // Partial index covers only sent/sending rows - small and focused.
    index("idx_messages_contact_sent")
      .on(table.contactId, table.sentAt)
      .where(sql`status IN ('sending', 'sent')`),
    // Idempotency: one message per step per membership (crash-safe).
    // Also serves as the lookup index for step advancement.
    uniqueIndex("uq_messages_membership_step").on(
      table.membershipId,
      table.flowStepOrder
    ),
    // Content generation worker query: pending_generation/generating messages.
    // Analogous to idx_messages_drain for the drain worker.
    index("idx_messages_generation")
      .on(table.tenantId, table.status, table.createdAt)
      .where(sql`status IN ('pending_generation', 'generating')`),
    // Webhook correlation: look up message by provider_message_id on every
    // inbound bounce/open/click event. Partial index excludes NULLs (most rows
    // before send). Added for task 29 (webhook ingestion).
    index("idx_messages_provider_id")
      .on(table.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
    // Analytics sending performance: per-tenant range scans on sent_at.
    index("idx_messages_tenant_sent")
      .on(table.tenantId, table.sentAt)
      .where(sql`sent_at IS NOT NULL`),
  ]
);
