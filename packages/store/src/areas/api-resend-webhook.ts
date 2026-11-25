/**
 * Queries used by packages/api/src/routes/webhooks/resend.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-resend-webhook.ts (Postgres) and, later,
 * ../d1/api-resend-webhook.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
export interface ApiResendWebhookQueries {
  /**
   * Encrypted config (as text) of the tenant's active Resend transport, or null.
   * Throws when tenantId is not a valid UUID (the caller treats that as not found).
   */
  findActiveResendConfig(tenantId: string): Promise<string | null>;
  /**
   * Set a terminal feedback value (bounced / complained) with one CAS update:
   * applies unless the message is already bounced or complained. True if updated.
   */
  setTerminalFeedback(args: { messageId: string; feedback: "bounced" | "complained" }): Promise<boolean>;
  /**
   * Advance a non-terminal feedback value with one CAS update: applies only when
   * the current feedback is one of `predecessors` (null = no feedback yet).
   * True if updated.
   */
  advanceFeedback(args: {
    messageId: string;
    feedback: "opened" | "clicked";
    predecessors: (string | null)[];
  }): Promise<boolean>;
  /** Insert a suppression for the (already lowercased) email; no-op if one exists. */
  insertSuppression(args: { tenantId: string; email: string; reason: "hard_bounce" | "complaint" }): Promise<void>;
  /** The tenant's message with this provider message id, or null. */
  findMessageByProviderId(args: { tenantId: string; providerMessageId: string }): Promise<{
    id: string;
    tenantId: string;
    recipientAddress: string | null;
  } | null>;
  /** Number of events stored for the message. */
  countMessageEvents(messageId: string): Promise<number>;
  /**
   * Insert a message event; no-op when (tenant_id, provider_event_id) already
   * exists. occurredAt is an ISO timestamp string, metadataJson a JSON string or null.
   */
  insertMessageEvent(args: {
    tenantId: string;
    messageId: string;
    eventType: string;
    occurredAt: string;
    providerEventId: string | null;
    metadataJson: string | null;
  }): Promise<void>;
}
