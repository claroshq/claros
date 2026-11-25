/**
 * Resend transport adapter.
 *
 * Sends email via the Resend HTTP API (https://api.resend.com/emails).
 * No external SDK dependency - uses Node's built-in fetch (Node 18+).
 *
 * Failure classification (from https://resend.com/docs/api-reference/errors):
 *
 * PERMANENT (mark message failed immediately, no retry):
 *   400 validation_error        - malformed request fields; will not improve on retry
 *   401 missing_api_key         - auth header absent; configuration fault
 *   401 restricted_api_key      - key lacks send permission; configuration fault
 *   403 invalid_api_key         - key is wrong; configuration fault
 *   403 validation_error        - unverified domain or test-mode restriction; config fault
 *   404 not_found               - wrong endpoint; should never happen with our fixed URL
 *   405 method_not_allowed      - should never happen with our fixed POST
 *   422 invalid_from_address    - from address format is invalid; configuration fault
 *   422 invalid_access          - key permission issue; configuration fault
 *   422 invalid_parameter       - parameter validation failure; bad request
 *   422 missing_required_field  - required field absent; bad request
 *   422 invalid_region          - bad region value; configuration fault
 *   422 invalid_attachment      - attachment issue; not applicable here
 *   451 security_error          - the message or recipient was flagged; permanent block
 *
 * TRANSIENT (leave at 'sending', reap will retry):
 *   409 invalid_idempotent_request      - same key + different payload; transient in
 *                                         practice because our key = messageId and the
 *                                         payload does not change between retries
 *   409 concurrent_idempotent_requests  - request still in-flight; retry after a delay
 *   429 rate_limit_exceeded             - throttling; retry after backoff
 *   429 monthly_quota_exceeded          - quota hit; retry after quota resets
 *   429 daily_quota_exceeded            - daily quota hit; retry next day
 *   500 application_error               - Resend server error; transient
 *   500 internal_server_error           - Resend server error; transient
 *   Network error / timeout             - no response received; cannot know provider intent
 *
 * UNCERTAIN (documented here):
 *   There is no Resend error code specifically for "invalid recipient email address".
 *   Resend accepts the API call and later emits a webhook event if the address is
 *   invalid or bounces. From the send-time perspective (HTTP response), Resend always
 *   returns 200 if the message was accepted regardless of recipient deliverability.
 *   This adapter therefore has no permanent-recipient-invalid path at send time.
 *
 * Provider message ID:
 *   On success Resend returns `{ "id": "<uuid>" }`. This is the provider message ID
 *   stored in lifecycle_messages.provider_message_id for later webhook correlation.
 */

import type { TransportAdapter, TransportSendParams, TransportSendResult } from "./transport-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * HTTP status codes that indicate a permanent failure.
 * Any 4xx that is NOT in the transient set (429, 409) is permanent.
 * 5xx are always transient.
 */
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 405, 422, 451]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a successful Resend response body. */
interface ResendSuccessBody {
  id: string;
}

/** Shape of a Resend error response body. */
interface ResendErrorBody {
  name: string;
  message: string;
  statusCode: number;
}

/**
 * Resend tag values may contain only ASCII letters, numbers, underscores and
 * dashes, at most 256 characters (https://resend.com/docs/api-reference/emails/send-email).
 * Ids are UUIDs and pass unchanged; anything else is made safe.
 */
function resendTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

// ---------------------------------------------------------------------------
// ResendTransportAdapter
// ---------------------------------------------------------------------------

/** Configuration for the Resend adapter. */
export interface ResendAdapterConfig {
  /** Resend API key (starts with re_). */
  apiKey: string;
}

/**
 * Resend transport adapter.
 *
 * Sends via the Resend HTTP API. Uses the message ID as the idempotency key
 * so provider-side deduplication is handled automatically.
 *
 * No external dependency: uses Node's built-in fetch (Node 18+, which is the
 * minimum Node version for this project).
 */
export class ResendTransportAdapter implements TransportAdapter {
  private readonly apiKey: string;

  constructor(config: ResendAdapterConfig) {
    this.apiKey = config.apiKey;
  }

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    const from = params.fromName
      ? `${params.fromName} <${params.from}>`
      : params.from;

    const body = {
      from,
      to: [params.to],
      subject: params.subject,
      html: params.bodyHtml,
      text: params.bodyText,
      headers: params.headers ?? {},
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
      ...(params.tags && Object.keys(params.tags).length > 0
        ? { tags: Object.entries(params.tags).map(([name, value]) => ({ name, value: resendTagValue(value) })) }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // Use the message ID as the idempotency key so provider-side
          // deduplication handles crash-recovery retries transparently.
          "Idempotency-Key": params.messageId,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      // Network error or timeout - always transient (no response received).
      return {
        success: false,
        error: `Resend network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
        permanent: false,
      };
    }

    if (response.ok) {
      // 200: message accepted by Resend.
      let responseBody: ResendSuccessBody;
      try {
        responseBody = await response.json() as ResendSuccessBody;
      } catch {
        // JSON parse failure on a 200 is unexpected but not a reason to fail.
        return { success: true };
      }
      return {
        success: true,
        providerMessageId: responseBody.id,
      };
    }

    // Non-2xx response: parse error body for context.
    let errorName = "unknown_error";
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json() as ResendErrorBody;
      errorName = errorBody.name ?? errorName;
      errorMessage = errorBody.message ?? errorMessage;
    } catch {
      // Could not parse error body - use status code only.
    }

    const status = response.status;
    const permanent = PERMANENT_STATUS_CODES.has(status);

    return {
      success: false,
      // Do NOT include the API key or recipient address in the error message.
      error: `Resend error ${status} (${errorName}): ${errorMessage}`,
      permanent,
    };
  }
}
