/**
 * Queries used by packages/worker/src/webhooks.ts (G5, G30): the outbound
 * webhook and analytics delivery job.
 */

/** A claimed outbox row with its endpoint and product. */
export interface WebhookDeliveryRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  event: string;
  payload: Record<string, unknown>;
  /** Attempts including the one this claim starts. */
  attempts: number;
  createdAt: Date;
  /** Null when the endpoint was removed or disabled after the row was written. */
  endpoint: {
    id: string;
    kind: string;
    url: string;
    secret: string | null;
    config: Record<string, unknown> | null;
  } | null;
}

/** What the delivery adds to a payload (ids resolved to names the receiver knows). */
export interface WebhookSubject {
  contact: {
    id: string;
    externalId: string;
    email: string | null;
    name: string | null;
    company: string | null;
    /** The contact's free-form properties (from identify and track), or null. */
    properties: Record<string, unknown> | null;
  } | null;
  message: {
    id: string;
    subject: string | null;
    actionType: string | null;
    step: number | null;
    status: string;
  } | null;
  flow: { id: string; slug: string | null; name: string } | null;
  topic: { slug: string; kind: string } | null;
}

export interface WorkerWebhooksQueries {
  /**
   * Claim up to `limit` pending rows whose next attempt is due: attempts is
   * incremented and next_attempt_at moved to now + leaseMs, so a crashed
   * delivery is retried after the lease and two concurrent ticks never
   * claim the same row. Oldest due first.
   */
  claimDueDeliveries(input: { now: Date; limit: number; leaseMs: number }): Promise<WebhookDeliveryRow[]>;
  /** Mark a claimed row delivered. */
  markDelivered(input: { id: string; now: Date }): Promise<void>;
  /** Record a failed attempt: retry at nextAttemptAt, or dead when it is null. */
  markAttemptFailed(input: { id: string; error: string; nextAttemptAt: Date | null; now: Date }): Promise<void>;
  /**
   * Resolve the ids of a payload within the product: message (and through it
   * contact, flow, topic), membership (its contact and flow), contact, flow,
   * or the contact owning `email`.
   */
  describeSubject(input: {
    tenantId: string;
    messageId?: string | null;
    membershipId?: string | null;
    contactId?: string | null;
    flowId?: string | null;
    email?: string | null;
  }): Promise<WebhookSubject>;
  /** Number of the product's messages waiting in pending_approval. */
  countPendingApprovals(tenantId: string): Promise<number>;
}
