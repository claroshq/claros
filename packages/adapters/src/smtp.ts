/**
 * SMTP transport adapter.
 *
 * Sends email via any standard SMTP server using Nodemailer.
 *
 * Configuration:
 *   - host: SMTP server hostname (required)
 *   - port: SMTP server port (required, typically 465, 587, or 25)
 *   - secure: true = implicit TLS on connect (port 465), false = STARTTLS upgrade (port 587/25)
 *   - username: SMTP auth username (optional - some relays allow unauthenticated)
 *   - password: SMTP auth password (optional)
 *   - ignoreTLS: skip STARTTLS entirely (for testing only; default false)
 *   - rejectUnauthorized: reject self-signed certificates (default true;
 *     set false for internal relays with self-signed certs)
 *
 * TLS handling:
 *   - Port 465: implicit TLS (secure: true). Connection is encrypted from the start.
 *   - Port 587: STARTTLS upgrade (secure: false). Connects plaintext, upgrades
 *     to TLS via the STARTTLS command before authentication.
 *   - Port 25: opportunistic STARTTLS. Same as 587 but some relays may not
 *     offer STARTTLS. Not recommended for authenticated connections.
 *   - Self-signed certificates on internal relays: set rejectUnauthorized = false.
 *     This disables certificate chain validation but keeps the connection encrypted.
 *     Only appropriate for a relay you control on a trusted network.
 *
 * Authentication:
 *   - When username and password are provided: AUTH LOGIN or AUTH PLAIN
 *     (Nodemailer negotiates the strongest method the server offers).
 *   - When omitted: no AUTH command is sent. This works for internal relays
 *     that authenticate by IP allowlist.
 *
 * What is NOT supported (and why):
 *   - OAUTH2: requires a token refresh flow, credential storage for refresh
 *     tokens, and per-provider OAuth configuration. Out of scope for community
 *     edition where the goal is "fill in what your provider gave you."
 *   - DKIM signing at the adapter level: DKIM is configured on the sending
 *     server or relay, not on the client. The adapter trusts that the relay
 *     handles DKIM. This matches how Postfix, Mailgun relays, and SES SMTP work.
 *
 * Failure classification:
 *   PERMANENT (mark message failed immediately):
 *     - SMTP 5xx responses: permanent rejection by the remote server.
 *       Examples: 550 mailbox not found, 553 invalid sender, 554 message refused.
 *     - Authentication failure (535): wrong credentials, will not improve on retry.
 *
 *   TRANSIENT (leave at 'sending', reap retries):
 *     - SMTP 4xx responses: temporary rejection (greylisting, rate limit, mailbox full).
 *     - Network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND): server unreachable.
 *     - TLS errors: handshake failure, certificate rejected.
 *     - Timeout: connection or command exceeded the deadline.
 *
 * Provider message ID:
 *   SMTP returns a server-assigned Message-ID in the final 250 response
 *   (e.g. "250 2.0.0 OK 1234567890 abc123 - gsmtp"). Nodemailer exposes
 *   this as `info.messageId`. Stored for reference but unlike Resend there
 *   is no webhook system to correlate it with delivery events.
 */

import { createTransport, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "./transport-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SMTP response codes that indicate a permanent failure. */
const PERMANENT_SMTP_CODES = new Set([
  // 5xx = permanent failures
  500, 501, 502, 503, 504, 550, 551, 552, 553, 554, 555, 556,
]);

/** Connection/command timeout in milliseconds. */
const SMTP_TIMEOUT_MS = 30_000;

/** Greeting timeout (time to wait for the server banner). */
const SMTP_GREETING_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the SMTP adapter. */
export interface SmtpAdapterConfig {
  /** SMTP server hostname. */
  host: string;
  /** SMTP server port (465 = implicit TLS, 587 = STARTTLS, 25 = plain/opportunistic). */
  port: number;
  /** true = implicit TLS (port 465). false = STARTTLS upgrade (port 587/25). */
  secure: boolean;
  /** SMTP auth username. Omit for unauthenticated relays. */
  username?: string;
  /** SMTP auth password. Omit for unauthenticated relays. */
  password?: string;
  /** Accept self-signed certificates. Default: true (reject). Set false for internal relays. */
  rejectUnauthorized?: boolean;
}

// ---------------------------------------------------------------------------
// SmtpTransportAdapter
// ---------------------------------------------------------------------------

/**
 * SMTP transport adapter.
 *
 * Creates a fresh Nodemailer transporter per instance. The transporter pools
 * connections internally (Nodemailer's default behavior for `pool: false` is
 * one connection per send, closed after). We do not enable pooling because
 * the drain processes messages sequentially and connection reuse is handled
 * by the OS TCP stack / keep-alive at the SMTP level.
 */
export class SmtpTransportAdapter implements TransportAdapter {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(config: SmtpAdapterConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.username
        ? { user: config.username, pass: config.password ?? "" }
        : undefined,
      tls: {
        rejectUnauthorized: config.rejectUnauthorized ?? true,
      },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    const from = params.fromName
      ? `${params.fromName} <${params.from}>`
      : params.from;

    try {
      const info = await this.transporter.sendMail({
        from,
        to: params.to,
        subject: params.subject,
        html: params.bodyHtml,
        text: params.bodyText,
        headers: params.headers ?? {},
        // Use our message ID as the SMTP Message-ID header for traceability.
        messageId: `${params.messageId}@claros`,
      });

      // Nodemailer resolves on 250 (accepted by the server).
      return {
        success: true,
        providerMessageId: info.messageId ?? undefined,
      };
    } catch (err) {
      return classifySmtpError(err);
    }
  }

  /**
   * Verify SMTP connection by performing EHLO + AUTH without sending.
   * Returns { ok: true } on success or { ok: false, error: string } on failure.
   *
   * This is used at configuration time (PUT /v1/settings/transport) to catch
   * wrong credentials immediately rather than at the first drain tick.
   */
  async verify(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Strip sensitive info (password) that Nodemailer sometimes includes
      // in auth failure messages.
      const safeMessage = message
        .replace(/pass(?:word)?[:=]\s*\S+/gi, "pass=***")
        .replace(/user[:=]\s*\S+/gi, "user=***");
      return { ok: false, error: safeMessage };
    }
  }

  /** Close the underlying connection (cleanup). */
  close(): void {
    this.transporter.close();
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an SMTP send error as permanent or transient.
 *
 * Nodemailer throws errors with a `responseCode` property for SMTP-level
 * rejections and standard Node.js error codes for network issues.
 */
function classifySmtpError(err: unknown): TransportSendResult {
  if (!(err instanceof Error)) {
    return {
      success: false,
      error: `SMTP error: ${String(err)}`,
      permanent: false,
    };
  }

  // Nodemailer attaches responseCode for SMTP protocol errors.
  const responseCode = (err as { responseCode?: number }).responseCode;

  if (responseCode !== undefined) {
    // 5xx = permanent, 4xx = transient
    const permanent = responseCode >= 500 || PERMANENT_SMTP_CODES.has(responseCode);
    // Do NOT include credentials or recipient in the error message.
    const safeMessage = err.message
      .replace(/pass(?:word)?[:=]\s*\S+/gi, "pass=***")
      .replace(/user[:=]\s*\S+/gi, "user=***");
    return {
      success: false,
      error: `SMTP ${responseCode}: ${safeMessage}`,
      permanent,
    };
  }

  // Network-level errors: always transient.
  const code = (err as { code?: string }).code;
  const errorContext = code ? `(${code})` : "";
  return {
    success: false,
    error: `SMTP connection error${errorContext}: ${err.message}`,
    permanent: false,
  };
}
