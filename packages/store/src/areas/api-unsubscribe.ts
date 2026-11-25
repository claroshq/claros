/**
 * Queries used by packages/api/src/routes/unsubscribe.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-unsubscribe.ts (Postgres) and, later,
 * ../d1/api-unsubscribe.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
import type { ContactTopicStatusRow } from "./shared-topics.js";

import type { OutboxEntry } from "./shared-outbox.js";

export interface ApiUnsubscribeQueries {
  /** Recipient address and status of a tenant's message, or null when the message does not exist. */
  getMessageRecipient(input: { tenantId: string; messageId: string }): Promise<{
    recipientAddress: string | null;
    status: string;
    contactId: string;
    topicId: string | null;
  } | null>;
  /** Write a suppression; idempotent (no-op when the address is already suppressed, case-insensitive). */
  suppressAddress(input: {
    tenantId: string;
    email: string;
    reason: string;
    source: string;
    /** Outbox entries (G5) written in the same atomic unit when the suppression is new. */
    outbox?: OutboxEntry[];
    now?: Date;
  }): Promise<void>;
  /** Id of the product whose public_host is this host (lowercase), or null. */
  findTenantIdByPublicHost(host: string): Promise<string | null>;
  /** Every topic of the tenant with the contact's explicit status for it. */
  listContactTopics(input: { tenantId: string; contactId: string }): Promise<ContactTopicStatusRow[]>;
  /**
   * Set the contact's status for topics of the tenant in one atomic unit (topics of other
   * tenants are ignored).
   */
  setContactTopicStatuses(input: {
    tenantId: string;
    contactId: string;
    statuses: Array<{ topicId: string; status: "subscribed" | "unsubscribed" }>;
    source: string;
    now: Date;
    /** Outbox entries (G5) written in the same atomic unit. */
    outbox?: OutboxEntry[];
  }): Promise<void>;
}
