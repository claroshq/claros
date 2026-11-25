/**
 * Transport adapter types - the interface contract between the drain worker
 * and email delivery adapters.
 *
 * Defined in packages/adapters so adapter implementations can live here
 * without a circular import through packages/worker.
 *
 * packages/worker imports these types and re-exports them as its public API
 * (packages/worker/src/transport.ts imports from here).
 */

// ---------------------------------------------------------------------------
// Send result
// ---------------------------------------------------------------------------

/** Result of attempting to send a single message via a transport adapter. */
export interface TransportSendResult {
  success: boolean;
  /** Provider's message ID (for tracking bounces/opens later). */
  providerMessageId?: string;
  /** Human-readable error when success = false. */
  error?: string;
  /**
   * When success = false, whether the failure is permanent.
   *
   * - true (permanent): the message should be marked 'failed' immediately.
   *   Examples: invalid sender configuration, domain not verified, API key wrong.
   *   Reap will not retry.
   * - false | undefined (transient): current behavior unchanged - message stays
   *   at 'sending' and reap retries up to MAX_RETRY_COUNT. Examples: network
   *   timeout, provider 429, provider 5xx.
   *
   * Ignored when success = true.
   */
  permanent?: boolean;
}

// ---------------------------------------------------------------------------
// Send params
// ---------------------------------------------------------------------------

/** Parameters passed to the transport adapter's send method. */
export interface TransportSendParams {
  /** Recipient email address. */
  to: string;
  /** Sender address (from transport_configs.from_email). */
  from: string;
  /** Sender display name (from transport_configs.from_name). */
  fromName?: string;
  /** Email subject line. */
  subject: string;
  /** HTML body. */
  bodyHtml: string;
  /** Plain text body (optional fallback). */
  bodyText?: string;
  /** Reply-To address (transport reply_to, else the product's brand.reply_to). */
  replyTo?: string;
  /** Additional headers (List-Unsubscribe, etc.). */
  headers?: Record<string, string>;
  /**
   * Provider tags (name -> value). Resend sends them as `tags`
   * (claros_tenant, claros_message_id, claros_flow); transports without tags
   * ignore them.
   */
  tags?: Record<string, string>;
  /** Message ID for idempotency / provider deduplication. */
  messageId: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * The contract that Phase 4 transport adapters must fulfill.
 *
 * Implementations:
 *   - ResendTransportAdapter (packages/adapters/src/resend.ts)
 *   - SmtpTransportAdapter (packages/adapters/src/smtp.ts, nodemailer on Node;
 *     apps/worker injects a worker-mailer adapter on Workers)
 *   - CloudflareTransportAdapter (packages/adapters/src/cloudflare.ts,
 *     Cloudflare Email Service, transactional mail only)
 *   - LogTransportAdapter (tests only, lives in packages/worker/tests/)
 */
export interface TransportAdapter {
  send(params: TransportSendParams): Promise<TransportSendResult>;
}
