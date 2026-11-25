/**
 * Queries used by packages/worker/src/drain.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-drain.ts (Postgres) and, later,
 * ../d1/worker-drain.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A message claimed by the drain (status already 'sending'). */
export interface WorkerDrainClaimedMessage {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  flowStepOrder: number | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  retryCount: number | null;
}

/** Contact fields the drain needs to send. */
export interface WorkerDrainContact {
  email: string | null;
  properties: unknown;
}

/** Flow fields the throttle gate needs. */
export interface WorkerDrainFlowThrottleInfo {
  flowClass: string;
  compiledPlan: unknown;
}

/** A contact's recent send history (status 'sending' or 'sent'). */
export interface WorkerDrainRecentSends {
  countLast24h: number;
  countLast7d: number;
  lastSentAt: Date | null;
}

/** Sender identity from the active transport config. */
export interface WorkerDrainSender {
  fromEmail: string;
  fromName: string | null;
}

/** Tenant name and raw settings JSON. */
export interface WorkerDrainTenant {
  name: string;
  settings: unknown;
  /** The product's public host (links in its mail use https://<publicHost>), or null. */
  publicHost: string | null;
}

export interface WorkerDrainQueries {
  /**
   * Atomically claim up to `limit` due approved messages of the given tenants (approved -> sending),
   * ordered critical first, then flow priority DESC, then FIFO. Each row is returned to exactly one
   * concurrent caller; rows locked by another caller are skipped, never waited on.
   */
  claimDrainBatch(input: { now: Date; limit: number; tenantIds: string[] }): Promise<WorkerDrainClaimedMessage[]>;
  /** Distinct tenants with approved messages due at `now` (read only, no locks). */
  listTenantsWithDueMessages(now: Date): Promise<string[]>;
  /** daily_limit of the tenant's active transport config, or null when unset or no active config. */
  getTransportDailyLimit(tenantId: string): Promise<number | null>;
  /** Number of the tenant's messages with status 'sent' and sent_at >= since. */
  countSentSince(tenantId: string, since: Date): Promise<number>;
  /** CAS sending -> approved; true when this call won. */
  releaseClaim(messageId: string, now: Date): Promise<boolean>;
  /** CAS sending -> approved with scheduled_send_at = sendAt; true when this call won. */
  deferClaim(messageId: string, sendAt: Date, now: Date): Promise<boolean>;
  /** CAS sending -> suppressed; true when this call won. */
  markSuppressed(messageId: string, now: Date): Promise<boolean>;
  /** Set recipient_address while the message is still 'sending' (CAS); true when this call won. */
  setRecipientAddress(messageId: string, email: string, now: Date): Promise<boolean>;
  /** CAS sending -> sent with sent_at and provider_message_id; true when this call won. */
  markSent(messageId: string, providerMessageId: string | null, now: Date): Promise<boolean>;
  /** CAS sending -> failed; true when this call won. */
  markFailed(messageId: string, now: Date): Promise<boolean>;
  /** The contact's email and properties, or null when the contact does not exist. */
  getContact(contactId: string): Promise<WorkerDrainContact | null>;
  /** Whether the email is on the tenant's suppression list (case-insensitive). */
  isSuppressed(tenantId: string, email: string): Promise<boolean>;
  /** The flow's class and compiled plan, or null when the flow does not exist. */
  getFlowThrottleInfo(flowId: string): Promise<WorkerDrainFlowThrottleInfo | null>;
  /** The tenant's raw settings JSON, or null when the tenant does not exist or has none. */
  getTenantSettings(tenantId: string): Promise<unknown>;
  /** The contact's sends in the last 7 days (and 24 hours) for the throttle gate. */
  getRecentSends(contactId: string, since24h: Date, since7d: Date): Promise<WorkerDrainRecentSends>;
  /** Sender from the tenant's active transport config, or null when none is active. */
  getSender(tenantId: string): Promise<WorkerDrainSender | null>;
  /** The tenant's name and settings, or null when the tenant does not exist. */
  getTenant(tenantId: string): Promise<WorkerDrainTenant | null>;
}
