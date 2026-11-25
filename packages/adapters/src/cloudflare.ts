/**
 * Cloudflare Email Service transport adapter (D16).
 *
 * Cloudflare's terms allow transactional mail only. The adapter itself sends
 * whatever it is given; the drain enforces the policy (a message may go
 * through a `cloudflare` transport only when its topic kind is
 * 'transactional', else it fails with reason `transport_policy`), and the
 * settings API refuses routing that would send other mail through it.
 *
 * Two ways to send, checked against the Cloudflare docs (2026-11):
 *
 *   1. Workers `send_email` binding (on Workers, for a transport stored
 *      without an account id and token; stored credentials win, so a
 *      transport keeps sending from the account its token belongs to when
 *      `claros deploy` adds the binding to an existing instance):
 *      https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *      wrangler: "send_email": [{ "name": "EMAIL" }]
 *      env.EMAIL.send({ from, to, subject, html, text, replyTo, headers })
 *        from/to/replyTo: string or { email, name } (both required in the object)
 *        resolves to { messageId }; failures throw Error with `code`
 *        (E_RATE_LIMIT_EXCEEDED, E_SENDER_NOT_VERIFIED, ...); malformed
 *        arguments throw TypeError without `code`.
 *
 *   2. REST API (Node, or Workers without the binding):
 *      https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 *      POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
 *      Authorization: Bearer <API token>
 *      { from, to, subject, html, text, headers, reply_to }
 *        from/to: string or { address, name } (examples/email-sending/recipients/)
 *        reply_to: string
 *      200 { success: true, result: { message_id, ... } }
 *      errors: { success: false, errors: [{ code, message }] }; 400/401/403/404
 *      are permanent, 429 and 5xx transient.
 *
 * Headers (https://developers.cloudflare.com/email-service/reference/headers/):
 * List-Unsubscribe and List-Unsubscribe-Post are allowed custom headers;
 * Reply-To must use the API field; Message-ID is platform-controlled and is
 * never sent. Cloudflare has no message tags; `tags` is ignored.
 */
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "./transport-types.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Shape of a Workers `send_email` binding (structured message API). */
export interface CloudflareSendEmailBinding {
  send(message: {
    from: string | { email: string; name: string };
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface CloudflareAdapterConfig {
  /** Cloudflare account id (REST API). */
  accountId?: string;
  /** API token with Email Sending permission (REST API). */
  apiToken?: string;
  /** Workers `send_email` binding; used when no account id and token are stored. */
  binding?: CloudflareSendEmailBinding;
  /** fetch implementation (tests). */
  fetch?: typeof fetch;
}

/** Binding error codes after which a retry can succeed. */
const TRANSIENT_BINDING_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_EMAIL_SENDING_NOT_READY",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
]);

interface CloudflareApiResponse {
  success?: boolean;
  result?: { message_id?: string } | null;
  errors?: Array<{ code?: number; message?: string }>;
}

export class CloudflareTransportAdapter implements TransportAdapter {
  constructor(private readonly config: CloudflareAdapterConfig) {}

  /** True when the adapter can send (a binding, or account id + token). */
  get configured(): boolean {
    return Boolean(this.config.binding || (this.config.accountId && this.config.apiToken));
  }

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    if (this.config.binding && !(this.config.accountId && this.config.apiToken)) {
      return this.sendWithBinding(this.config.binding, params);
    }
    return this.sendWithRest(params);
  }

  private async sendWithBinding(
    binding: CloudflareSendEmailBinding,
    params: TransportSendParams,
  ): Promise<TransportSendResult> {
    try {
      const result = await binding.send({
        from: params.fromName ? { email: params.from, name: params.fromName } : params.from,
        to: params.to,
        subject: params.subject,
        html: params.bodyHtml,
        ...(params.bodyText ? { text: params.bodyText } : {}),
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
        ...(params.headers && Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
      });
      return { success: true, providerMessageId: result?.messageId };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (typeof code === "string") {
        return {
          success: false,
          error: `Cloudflare Email Service error ${code}: ${message}`,
          permanent: !TRANSIENT_BINDING_CODES.has(code),
        };
      }
      // TypeError (malformed message) is permanent; anything else without a
      // code is treated as transient (no answer from the service).
      return {
        success: false,
        error: `Cloudflare Email Service error: ${message}`,
        permanent: err instanceof TypeError,
      };
    }
  }

  private async sendWithRest(params: TransportSendParams): Promise<TransportSendResult> {
    const { accountId, apiToken } = this.config;
    if (!accountId || !apiToken) {
      return {
        success: false,
        error: "Cloudflare Email Service needs an account id and API token (or the send_email binding on Workers).",
        permanent: true,
      };
    }
    const doFetch = this.config.fetch ?? fetch;
    const body = {
      from: params.fromName ? { address: params.from, name: params.fromName } : params.from,
      to: params.to,
      subject: params.subject,
      html: params.bodyHtml,
      ...(params.bodyText ? { text: params.bodyText } : {}),
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
      ...(params.headers && Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
    };

    let response: Response;
    try {
      response = await doFetch(
        `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      return {
        success: false,
        error: `Cloudflare Email Service network error: ${err instanceof Error ? err.message : String(err)}`,
        permanent: false,
      };
    }

    let json: CloudflareApiResponse | null;
    try {
      json = (await response.json()) as CloudflareApiResponse;
    } catch {
      json = null;
    }

    if (response.ok && json?.success !== false) {
      return { success: true, providerMessageId: json?.result?.message_id ?? undefined };
    }

    const first = json?.errors?.[0];
    const detail = first ? `${first.code ?? ""} ${first.message ?? ""}`.trim() : `HTTP ${response.status}`;
    const transient = response.status === 429 || response.status >= 500;
    return {
      success: false,
      // Never include the token or the recipient.
      error: `Cloudflare Email Service error ${response.status}: ${detail}`,
      permanent: !transient,
    };
  }
}
