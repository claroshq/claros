/**
 * Outbox entries (G5, G30) that a state-changing store method writes in the
 * same atomic unit as the change (Postgres transaction, D1 batch).
 *
 * One entry becomes one webhook_outbox row per enabled endpoint of the
 * product subscribed to `event` (none when the product has no endpoint).
 * The payload carries ids (message_id, contact_id, flow_id, ...); the
 * delivery job adds the product slug and the contact's external_id.
 */
export interface OutboxEntry {
  event: string;
  payload: Record<string, unknown>;
  /** Unique per product and endpoint: a second entry with the same key is dropped. */
  dedupKey?: string | null;
  /** First delivery attempt; default now. */
  deliverAt?: Date;
}
